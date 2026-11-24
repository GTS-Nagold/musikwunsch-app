const axios = require('axios');
const fs = require('fs');
const path = require('path');

const TOKEN_FILE = path.join(__dirname, '.tokens.json');

class SpotifyClient {
  constructor() {
    this.clientId = process.env.SPOTIFY_CLIENT_ID;
    this.clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
    this.redirectUri = process.env.REDIRECT_URI;
    this.accessToken = null;
    this.tokenExpiry = 0;
    this.refreshToken = process.env.SPOTIFY_REFRESH_TOKEN || null;
    this._queueCache = null;
    this._queueCacheTime = 0;
    this._queueRawCache = null;
    this._queueRawCacheTime = 0;
    this._searchCache = new Map();
    this._lastRequestTime = 0;
    this._requestChain = Promise.resolve(); // serialisierender Request-Queue
    this._refreshPromise = null;            // Token-Refresh-Dedup
    this._retryAfterUntil = 0;             // 429 Retry-After Sperre
    this._loadTokens();
  }

  // ── Serialisierender Request-Queue ───────────────────────────────────────
  // Alle Spotify API-Calls laufen nacheinander, min. 150ms Abstand.
  // Race Conditions und Bursts sind damit strukturell unmöglich.
  _enqueue(fn) {
    const result = this._requestChain.then(async () => {
      // 429-Sperre respektieren
      const retryWait = Math.max(0, this._retryAfterUntil - Date.now());
      if (retryWait > 0) {
        console.log(`⏳ Spotify 429-Sperre – warte ${Math.round(retryWait/1000)}s`);
        await new Promise(r => setTimeout(r, retryWait));
      }
      // Mindestabstand 150ms zum letzten Call
      const gap = Math.max(0, this._lastRequestTime + 150 - Date.now());
      if (gap > 0) await new Promise(r => setTimeout(r, gap));
      this._lastRequestTime = Date.now();
      try {
        return await fn();
      } catch (err) {
        // 429: Retry-After aus Header lesen und Sperre setzen
        const status = err.response?.status;
        if (status === 429) {
          const retryAfter = parseInt(err.response?.headers?.['retry-after'] || '10', 10);
          this._retryAfterUntil = Date.now() + retryAfter * 1000;
          console.warn(`⚠️ Spotify 429 – gesperrt für ${retryAfter}s`);
        }
        throw err;
      }
    });
    // Chain immer weiterführen, auch bei Fehler
    this._requestChain = result.catch(() => {});
    return result;
  }

  // ── Token-Verwaltung ─────────────────────────────────────────────────────

  _loadTokens() {
    try {
      if (fs.existsSync(TOKEN_FILE)) {
        const d = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
        if (!this.refreshToken && d.refreshToken) this.refreshToken = d.refreshToken;
        this.accessToken = d.accessToken;
        this.tokenExpiry = d.tokenExpiry || 0;
      }
    } catch {}
  }

  _saveTokens() {
    try {
      fs.writeFileSync(TOKEN_FILE, JSON.stringify({
        refreshToken: this.refreshToken,
        accessToken: this.accessToken,
        tokenExpiry: this.tokenExpiry
      }, null, 2));
    } catch (e) {
      console.warn('Token-Datei konnte nicht gespeichert werden:', e.message);
    }
  }

  _basicAuth() {
    return 'Basic ' + Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
  }

  async exchangeCode(code) {
    const resp = await axios.post(
      'https://accounts.spotify.com/api/token',
      new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: this.redirectUri }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: this._basicAuth() } }
    );
    this.accessToken = resp.data.access_token;
    this.refreshToken = resp.data.refresh_token;
    this.tokenExpiry = Date.now() + (resp.data.expires_in - 60) * 1000;
    this._saveTokens();
    console.log('✅ Spotify-Auth erfolgreich.');
    return resp.data;
  }

  async _refreshAccessToken() {
    // Dedup: wenn Refresh schon läuft, dasselbe Promise zurückgeben
    if (this._refreshPromise) return this._refreshPromise;
    if (!this.refreshToken) throw new Error('Kein Refresh Token. Bitte /auth aufrufen.');
    this._refreshPromise = axios.post(
      'https://accounts.spotify.com/api/token',
      new URLSearchParams({ grant_type: 'refresh_token', refresh_token: this.refreshToken }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: this._basicAuth() } }
    ).then(resp => {
      this.accessToken = resp.data.access_token;
      if (resp.data.refresh_token) this.refreshToken = resp.data.refresh_token;
      this.tokenExpiry = Date.now() + (resp.data.expires_in - 60) * 1000;
      this._saveTokens();
    }).finally(() => {
      this._refreshPromise = null;
    });
    return this._refreshPromise;
  }

  async _headers() {
    if (!this.accessToken || Date.now() > this.tokenExpiry) {
      await this._refreshAccessToken();
    }
    return { Authorization: `Bearer ${this.accessToken}` };
  }

  isConnected() {
    return !!(this.refreshToken || this.accessToken);
  }

  // ── Spotify API ──────────────────────────────────────────────────────────

  async getPlaybackState() {
    try {
      return await this._enqueue(async () => {
        const resp = await axios.get('https://api.spotify.com/v1/me/player', { headers: await this._headers() });
        return resp.data || null;
      });
    } catch {
      return null;
    }
  }

  async search(query) {
    const key = query.toLowerCase().trim();
    const cached = this._searchCache.get(key);
    if (cached && Date.now() - cached.time < 30_000) return cached.results;

    const results = await this._enqueue(async () => {
      // Double-check cache (ein anderer Request könnte inzwischen gecacht haben)
      const c = this._searchCache.get(key);
      if (c && Date.now() - c.time < 30_000) return c.results;
      const url = `https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=track&limit=10`;
      const resp = await axios.get(url, { headers: await this._headers() });
      return (resp.data.tracks?.items || []).map(t => ({
        id: t.id, uri: t.uri, name: t.name,
        artist: (t.artists || []).map(a => a.name).join(', '),
        image: t.album?.images?.[2]?.url || t.album?.images?.[0]?.url || null,
        preview: t.preview_url || null
      }));
    });

    if (this._searchCache.size > 200) {
      const oldest = [...this._searchCache.entries()].sort((a, b) => a[1].time - b[1].time)[0][0];
      this._searchCache.delete(oldest);
    }
    this._searchCache.set(key, { results, time: Date.now() });
    return results;
  }

  async _fetchQueueRaw() {
    const now = Date.now();
    if (this._queueRawCache && now - this._queueRawCacheTime < 8_000) return this._queueRawCache;

    return this._enqueue(async () => {
      // Double-check cache
      const n = Date.now();
      if (this._queueRawCache && n - this._queueRawCacheTime < 8_000) return this._queueRawCache;
      const resp = await axios.get('https://api.spotify.com/v1/me/player/queue', { headers: await this._headers() });
      this._queueRawCache = resp.data;
      this._queueRawCacheTime = Date.now();
      const uris = [];
      if (resp.data.currently_playing?.uri) uris.push(resp.data.currently_playing.uri);
      (resp.data.queue || []).forEach(t => { if (t.uri) uris.push(t.uri); });
      this._queueCache = uris;
      this._queueCacheTime = this._queueRawCacheTime;
      return resp.data;
    });
  }

  async getQueue() {
    const now = Date.now();
    if (this._queueCache && now - this._queueCacheTime < 8_000) return this._queueCache;
    await this._fetchQueueRaw();
    return this._queueCache;
  }

  async isInQueue(trackUri) {
    return (await this.getQueue()).includes(trackUri);
  }

  async getQueueInfo() {
    const data = await this._fetchQueueRaw();
    const fmt = t => t ? { name: t.name, artist: (t.artists || []).map(a => a.name).join(', '), uri: t.uri } : null;
    return {
      currentlyPlaying: fmt(data.currently_playing),
      queue: (data.queue || []).slice(0, 30).map(fmt)
    };
  }

  async addToQueue(trackUri) {
    return this._enqueue(async () => {
      await axios.post(
        `https://api.spotify.com/v1/me/player/queue?uri=${encodeURIComponent(trackUri)}`,
        null,
        { headers: await this._headers() }
      );
      this._queueCache = null;
      this._queueRawCache = null;
    });
  }
}

module.exports = SpotifyClient;
