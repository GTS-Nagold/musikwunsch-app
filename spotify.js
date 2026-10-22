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
    // App-Token (Client Credentials – kein User nötig, für Playlist-Tracks)
    this._appToken = null;
    this._appTokenExpiry = 0;
    this._loadTokens();
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
    console.log('✅ Spotify-Auth erfolgreich. Refresh Token:', this.refreshToken);
    return resp.data;
  }

  async _refreshAccessToken() {
    if (!this.refreshToken) {
      throw new Error('Kein Refresh Token vorhanden. Bitte /auth aufrufen.');
    }
    const resp = await axios.post(
      'https://accounts.spotify.com/api/token',
      new URLSearchParams({ grant_type: 'refresh_token', refresh_token: this.refreshToken }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: this._basicAuth() } }
    );
    this.accessToken = resp.data.access_token;
    if (resp.data.refresh_token) this.refreshToken = resp.data.refresh_token;
    this.tokenExpiry = Date.now() + (resp.data.expires_in - 60) * 1000;
    this._saveTokens();
  }

  async _headers() {
    if (!this.accessToken || Date.now() > this.tokenExpiry) {
      await this._refreshAccessToken();
    }
    return { Authorization: `Bearer ${this.accessToken}` };
  }

  // App-Token via Client Credentials – kein User-Login nötig
  // Funktioniert für öffentliche Playlists ohne Development-Mode-Einschränkungen
  async _appHeaders() {
    if (!this._appToken || Date.now() > this._appTokenExpiry) {
      const resp = await axios.post(
        'https://accounts.spotify.com/api/token',
        new URLSearchParams({ grant_type: 'client_credentials' }),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: this._basicAuth() } }
      );
      this._appToken = resp.data.access_token;
      this._appTokenExpiry = Date.now() + (resp.data.expires_in - 60) * 1000;
      console.log('✅ Spotify App-Token erneuert (Client Credentials)');
    }
    return { Authorization: `Bearer ${this._appToken}` };
  }

  isConnected() {
    return !!(this.refreshToken || this.accessToken);
  }

  // ── Spotify API Aufrufe ──────────────────────────────────────────────────

  async getPlaybackState() {
    const h = await this._headers();
    try {
      const resp = await axios.get('https://api.spotify.com/v1/me/player', { headers: h });
      return resp.data || null;
    } catch {
      return null;
    }
  }

  async getAllPlaylists() {
    const h = await this._headers();
    let url = 'https://api.spotify.com/v1/me/playlists?limit=50';
    const all = [];
    while (url) {
      const resp = await axios.get(url, { headers: h });
      all.push(...(resp.data.items || []));
      url = resp.data.next;
    }
    return all;
  }

  async getFilteredPlaylists(danceNames, blocklist = []) {
    const all = await this.getAllPlaylists();
    return all
      .filter(p => {
        if (!p || !p.name) return false;
        const lower = p.name.toLowerCase();
        // Blocklist zuerst prüfen
        if (blocklist.some(b => lower.includes(b.toLowerCase()))) return false;
        // Dann Tanzname prüfen
        return danceNames.some(d => lower.includes(d.toLowerCase()));
      })
      .map(p => ({
        id: p.id,
        name: p.name,
        image: p.images?.[0]?.url || null,
        trackCount: p.tracks?.total || 0
      }))
      .sort((a, b) => a.name.localeCompare(b.name, 'de'));
  }

  async getPlaylistTracks(playlistId) {
    // Erst App-Token versuchen (Client Credentials, keine User-Einschränkungen)
    // Bei 401/403 Fallback auf User-Token (für private eigene Playlists)
    let h;
    try {
      h = await this._appHeaders();
    } catch (e) {
      console.warn('App-Token fehlgeschlagen, nutze User-Token:', e.message);
      h = await this._headers();
    }

    let url = `https://api.spotify.com/v1/playlists/${encodeURIComponent(playlistId)}/tracks`;
    const tracks = [];
    let usedFallback = false;

    while (url) {
      try {
        const resp = await axios.get(url, { headers: h });
        const items = (resp.data.items || []).filter(i => i.track?.id && !i.track.is_local);
        tracks.push(...items.map(i => ({
          id: i.track.id,
          uri: i.track.uri,
          name: i.track.name,
          artist: (i.track.artists || []).map(a => a.name).join(', '),
          image: i.track.album?.images?.[2]?.url || i.track.album?.images?.[0]?.url || null
        })));
        url = resp.data.next;
      } catch (err) {
        const status = err.response?.status;
        const spotifyMsg = err.response?.data?.error?.message;

        // Bei 401/403 mit App-Token: Fallback auf User-Token (private Playlist)
        if ((status === 401 || status === 403) && !usedFallback) {
          console.log(`App-Token 403 für ${playlistId}, versuche User-Token...`);
          usedFallback = true;
          h = await this._headers();
          url = `https://api.spotify.com/v1/playlists/${encodeURIComponent(playlistId)}/tracks`;
          continue;
        }

        console.error(`Spotify Track-Fehler ${status} für Playlist ${playlistId}:`, spotifyMsg || err.message);
        throw new Error(spotifyMsg ? `Spotify: ${spotifyMsg}` : `Playlist konnte nicht geladen werden (${status})`);
      }
    }
    return tracks;
  }

  async search(query) {
    const h = await this._headers();
    try {
      const resp = await axios.get('https://api.spotify.com/v1/search', {
        headers: h,
        params: { q: query, type: 'track' }
      });
      return (resp.data.tracks?.items || []).map(t => ({
        id: t.id,
        uri: t.uri,
        name: t.name,
        artist: (t.artists || []).map(a => a.name).join(', '),
        image: t.album?.images?.[2]?.url || t.album?.images?.[0]?.url || null
      }));
    } catch (err) {
      // Spotify-Fehlermeldung weitergeben für besseres Debugging
      const spotifyMsg = err.response?.data?.error?.message;
      const status = err.response?.status;
      console.error(`Spotify Suche Fehler ${status}:`, spotifyMsg || err.message, '| Query:', query);
      throw new Error(spotifyMsg ? `Spotify: ${spotifyMsg}` : `Suche fehlgeschlagen (${status})`);
    }
  }

  async getQueue() {
    const now = Date.now();
    if (this._queueCache && now - this._queueCacheTime < 8000) {
      return this._queueCache;
    }
    const h = await this._headers();
    const resp = await axios.get('https://api.spotify.com/v1/me/player/queue', { headers: h });
    const uris = [];
    if (resp.data.currently_playing?.uri) uris.push(resp.data.currently_playing.uri);
    (resp.data.queue || []).forEach(t => { if (t.uri) uris.push(t.uri); });
    this._queueCache = uris;
    this._queueCacheTime = now;
    return uris;
  }

  async isInQueue(trackUri) {
    const queue = await this.getQueue();
    return queue.includes(trackUri);
  }

  async addToQueue(trackUri) {
    const h = await this._headers();
    await axios.post(
      `https://api.spotify.com/v1/me/player/queue?uri=${encodeURIComponent(trackUri)}`,
      null,
      { headers: h }
    );
    // Cache invalidieren
    this._queueCache = null;
  }

  async getMe() {
    const h = await this._headers();
    const resp = await axios.get('https://api.spotify.com/v1/me', { headers: h });
    return resp.data;
  }

  async debugPlaylist(playlistId) {
    const h = await this._appHeaders();
    const url = `https://api.spotify.com/v1/playlists/${encodeURIComponent(playlistId)}/tracks`;
    const resp = await axios.get(url, { headers: h });
    return { status: 200, tokenType: 'client_credentials', items: resp.data.items?.length, total: resp.data.total };
  }
}

module.exports = SpotifyClient;
