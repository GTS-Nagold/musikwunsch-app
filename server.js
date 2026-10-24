require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const SpotifyClient = require('./spotify');

// ── Konfiguration ────────────────────────────────────────────────────────────
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));

// ── Kuratierte Songlisten (aus data/songs.json) ──────────────────────────────
let songsDb = {};
try {
  songsDb = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'songs.json'), 'utf8'));
  const total = Object.values(songsDb).reduce((s, arr) => s + arr.length, 0);
  console.log(`✅ Songlisten geladen: ${Object.keys(songsDb).length} Tanzstile, ${total} Songs`);
} catch {
  console.warn('⚠️ data/songs.json nicht gefunden – Tanzstile fallen auf Spotify-Suche zurück');
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const spotify = new SpotifyClient();

// ── In-Memory State ──────────────────────────────────────────────────────────
let activeParty = null;
// { token, name, startedAt, expiresAt|null, sessionDurationMs }

const guestCooldowns  = new Map(); // sessionId → timestamp
const COOLDOWN_MS     = 180_000;  // 3 Minuten zwischen Wünschen

const guestSessions   = new Map(); // sessionId → checkinTimestamp
const expiredSessions = new Set(); // blacklisted sessionIds (müssen QR neu scannen)
const DEFAULT_SESSION_MS = 60 * 60_000; // 60 Minuten Standard

const wishHistory = []; // { timestamp, name, ip, title, artist }

// ── Middleware ───────────────────────────────────────────────────────────────

function requireParty(req, res, next) {
  const token     = req.query.party || req.headers['x-party-token'];
  const sessionId = req.headers['x-session-id'];

  if (!activeParty)
    return res.status(403).json({ error: 'Keine Party aktiv. Bitte den QR-Code scannen.' });
  if (activeParty.token !== token)
    return res.status(403).json({ error: 'Ungültiger Party-Code.' });
  if (activeParty.expiresAt && Date.now() > activeParty.expiresAt) {
    activeParty = null;
    return res.status(403).json({ error: 'Diese Party ist beendet.' });
  }
  if (sessionId) {
    const checkin  = guestSessions.get(sessionId);
    const duration = activeParty.sessionDurationMs || DEFAULT_SESSION_MS;
    if (!checkin || Date.now() - checkin > duration) {
      expiredSessions.add(sessionId); // blacklisten → kein Re-Checkin per URL möglich
      return res.status(403).json({
        error: 'Deine Session ist abgelaufen. Bitte QR-Code neu scannen.',
        reason: 'session_expired'
      });
    }
  }
  next();
}

function requireAdmin(req, res, next) {
  const pwd = req.headers['x-admin-password'] || req.body?.adminPassword;
  if (pwd !== process.env.ADMIN_PASSWORD)
    return res.status(401).json({ error: 'Falsches Admin-Passwort.' });
  next();
}

// ── Öffentliche API ──────────────────────────────────────────────────────────

// Branding-Konfiguration (für Frontend)
app.get('/api/config', (req, res) => res.json(config));

// Gast-Checkin: QR-Scan startet das Zeitfenster
app.post('/api/party/checkin', (req, res) => {
  const token     = req.query.party || req.headers['x-party-token'];
  const { sessionId } = req.body;

  if (!activeParty || activeParty.token !== token)
    return res.status(403).json({ error: 'Keine aktive Party.' });
  if (activeParty.expiresAt && Date.now() > activeParty.expiresAt) {
    activeParty = null;
    return res.status(403).json({ error: 'Diese Party ist beendet.' });
  }
  if (!sessionId) return res.status(400).json({ error: 'Fehlende sessionId.' });

  // Abgelaufene Sessions dürfen sich NICHT neu einchecken – QR-Scan erzwingen
  if (expiredSessions.has(sessionId)) {
    return res.status(403).json({
      error: 'Session abgelaufen. Bitte QR-Code neu scannen.',
      reason: 'session_expired'
    });
  }

  guestSessions.set(sessionId, Date.now());

  if (guestSessions.size > 5000) {
    const cutoff = Date.now() - (activeParty.sessionDurationMs || DEFAULT_SESSION_MS);
    for (const [id, ts] of guestSessions) if (ts < cutoff) guestSessions.delete(id);
  }

  const duration = activeParty.sessionDurationMs || DEFAULT_SESSION_MS;
  res.json({ success: true, expiresAt: Date.now() + duration });
});

// Party-Status prüfen
app.get('/api/party/status', (req, res) => {
  const token = req.query.party || req.headers['x-party-token'];
  if (!activeParty) return res.json({ active: false, reason: 'no_party' });
  if (activeParty.token !== token) return res.json({ active: false, reason: 'wrong_token' });
  if (activeParty.expiresAt && Date.now() > activeParty.expiresAt) {
    activeParty = null;
    return res.json({ active: false, reason: 'expired' });
  }
  res.json({ active: true, name: activeParty.name });
});

// ── Gast-API (Party-Token + Session erforderlich) ────────────────────────────

// Kuratierte Songs eines Tanzstils
app.get('/api/dance/:id/songs', requireParty, (req, res) => {
  const songs = songsDb[req.params.id];
  if (!songs) return res.status(404).json({ error: 'Tanzstil nicht gefunden.' });
  res.json(songs.slice(0, 60));
});

// Spotify-Freisuche
app.get('/api/search', requireParty, async (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 2) return res.json([]);
  try {
    res.json(await spotify.search(q));
  } catch (err) {
    console.error('Suche:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Song per Titel + Artist wünschen (kuratierte Listen)
app.post('/api/wish-by-name', requireParty, async (req, res) => {
  const { title, artist, sessionId, guestName } = req.body;
  if (!title || !sessionId) return res.status(400).json({ error: 'Fehlende Parameter.' });

  const lastWish = guestCooldowns.get(sessionId);
  if (lastWish && Date.now() - lastWish < COOLDOWN_MS) {
    const remaining = Math.ceil((COOLDOWN_MS - (Date.now() - lastWish)) / 1000);
    return res.status(429).json({ error: `Bitte noch ${remaining} Sekunden warten.`, remaining });
  }

  try {
    const results = await spotify.search(artist ? `${title} ${artist}` : title);
    if (!results.length) return res.status(404).json({ error: 'Song auf Spotify nicht gefunden.' });

    const track = results[0];
    if (await spotify.isInQueue(track.uri)) {
      return res.status(409).json({ error: 'Dieser Song steht schon in der Queue. 🎵' });
    }

    await spotify.addToQueue(track.uri);
    guestCooldowns.set(sessionId, Date.now());
    cleanupMap(guestCooldowns, COOLDOWN_MS);

    // Queue-Position ermitteln: kurz warten bis Spotify API aktualisiert ist
    let queuePosition = null;
    try {
      await new Promise(r => setTimeout(r, 800));
      const qi = await spotify.getQueueInfo();
      const idx = qi.queue.findIndex(t => t && t.uri === track.uri);
      queuePosition = idx >= 0 ? idx + 1 : null;
    } catch {}

    // History loggen
    wishHistory.push({
      timestamp: new Date().toISOString(),
      name:      guestName || 'Unbekannt',
      ip:        req.headers['x-forwarded-for']?.split(',')[0].trim() || req.ip || '–',
      title:     track.name,
      artist:    track.artist
    });

    res.json({ success: true, matched: { name: track.name, artist: track.artist }, queuePosition });
  } catch (err) {
    console.error('Wish-by-name:', err.message);
    const s = err.response?.status;
    res.status(500).json({
      error: (s === 404 || s === 400)
        ? 'Keine aktive Wiedergabe. Bitte Musik auf dem Tanzschul-Gerät starten.'
        : err.message
    });
  }
});

// Song per URI wünschen (Spotify-Suche)
app.post('/api/wish', requireParty, async (req, res) => {
  const { trackUri, sessionId, guestName, trackName, trackArtist } = req.body;
  if (!trackUri || !sessionId) return res.status(400).json({ error: 'Fehlende Parameter.' });

  const lastWish = guestCooldowns.get(sessionId);
  if (lastWish && Date.now() - lastWish < COOLDOWN_MS) {
    const remaining = Math.ceil((COOLDOWN_MS - (Date.now() - lastWish)) / 1000);
    return res.status(429).json({ error: `Bitte noch ${remaining} Sekunden warten.`, remaining });
  }

  try {
    if (await spotify.isInQueue(trackUri)) {
      return res.status(409).json({ error: 'Dieser Song steht schon in der Queue. 🎵' });
    }
    await spotify.addToQueue(trackUri);
    guestCooldowns.set(sessionId, Date.now());
    cleanupMap(guestCooldowns, COOLDOWN_MS);

    // Queue-Position ermitteln: Song per URI suchen → echter Index im User-Queue
    let queuePosition = null;
    try {
      const qi = await spotify.getQueueInfo();
      const idx = qi.queue.findIndex(t => t && t.uri === trackUri);
      queuePosition = idx >= 0 ? idx + 1 : null;
    } catch {}

    // History loggen
    wishHistory.push({
      timestamp: new Date().toISOString(),
      name:      guestName || 'Unbekannt',
      ip:        req.headers['x-forwarded-for']?.split(',')[0].trim() || req.ip || '–',
      title:     trackName || trackUri,
      artist:    trackArtist || '–'
    });

    res.json({ success: true, queuePosition });
  } catch (err) {
    console.error('Wish:', err.message);
    const s = err.response?.status;
    res.status(500).json({
      error: (s === 404 || s === 400)
        ? 'Keine aktive Wiedergabe. Bitte Musik auf dem Tanzschul-Gerät starten.'
        : err.message
    });
  }
});

// ── Admin-API ────────────────────────────────────────────────────────────────

app.get('/admin/status', requireAdmin, async (req, res) => {
  const playback = await spotify.getPlaybackState();
  res.json({
    spotifyConnected: spotify.isConnected(),
    spotifyPlaying:   !!playback?.is_playing,
    spotifyDevice:    playback?.device?.name || null,
    party:            activeParty,
    historyCount:     wishHistory.length
  });
});

app.post('/admin/party/start', requireAdmin, (req, res) => {
  const { name, durationHours, sessionDurationMinutes } = req.body;
  const token = process.env.PARTY_TOKEN || crypto.randomBytes(3).toString('hex');
  activeParty = {
    token,
    name:              (name || 'Party').trim(),
    startedAt:         Date.now(),
    expiresAt:         durationHours ? Date.now() + Number(durationHours) * 3_600_000 : null,
    sessionDurationMs: (Number(sessionDurationMinutes) || 60) * 60_000
  };
  guestCooldowns.clear();
  guestSessions.clear();
  expiredSessions.clear();
  const url = `${process.env.APP_URL}/?party=${token}`;
  console.log(`🎉 Party: "${activeParty.name}" – Session: ${sessionDurationMinutes || 60} Min.`);
  res.json({ success: true, party: activeParty, url });
});

// Aktuelle Spotify-Queue anzeigen
app.get('/admin/queue', requireAdmin, async (req, res) => {
  try {
    res.json(await spotify.getQueueInfo());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// History als CSV herunterladen
app.get('/admin/history.csv', requireAdmin, (req, res) => {
  const header = 'Zeitpunkt,Name,IP,Titel,Artist\n';
  const rows = wishHistory.map(h =>
    [h.timestamp, h.name, h.ip, h.title, h.artist]
      .map(v => `"${String(v).replace(/"/g, '""')}"`)
      .join(',')
  ).join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="musikwunsch-history.csv"');
  res.send('﻿' + header + rows); // BOM für Excel
});

// Config live aktualisieren
app.post('/admin/config', requireAdmin, (req, res) => {
  try {
    const updated = { ...config, ...req.body };
    fs.writeFileSync(path.join(__dirname, 'config.json'), JSON.stringify(updated, null, 2));
    Object.assign(config, updated);
    res.json({ success: true, config });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/admin/party/stop', requireAdmin, (req, res) => {
  console.log(`🛑 Party beendet: "${activeParty?.name || '–'}"`);
  activeParty = null;
  guestCooldowns.clear();
  guestSessions.clear();
  expiredSessions.clear();
  res.json({ success: true });
});

// ── Spotify OAuth ────────────────────────────────────────────────────────────

app.get('/auth', (req, res) => {
  const scopes = [
    'user-modify-playback-state',
    'user-read-playback-state',
    'playlist-read-private',
    'playlist-read-collaborative'
  ].join(' ');
  const params = new URLSearchParams({
    client_id:     process.env.SPOTIFY_CLIENT_ID,
    response_type: 'code',
    redirect_uri:  process.env.REDIRECT_URI,
    scope:         scopes
  });
  res.redirect('https://accounts.spotify.com/authorize?' + params);
});

app.get('/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.send(`<p>Fehler: ${error}</p>`);
  try {
    const data = await spotify.exchangeCode(code);
    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8">
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <title>Spotify verbunden</title>
      <style>body{font-family:sans-serif;padding:2rem;text-align:center;background:#f0f4ff}
      h2{color:#2f3d7c}.box{background:#fff;border-radius:1rem;padding:1.5rem;display:inline-block;margin:1rem auto;text-align:left}
      code{background:#eee;padding:.2em .5em;border-radius:.3em;font-size:.85em;word-break:break-all}
      a{color:#2f3d7c}</style></head><body>
      <h2>✅ Spotify erfolgreich verbunden!</h2>
      <div class="box">
        <p><strong>Refresh Token – in Render als Env-Variable eintragen:</strong></p>
        <code id="rt" style="display:block;padding:.75rem;margin:.5rem 0;cursor:pointer"
          onclick="navigator.clipboard.writeText(this.innerText);this.style.background='#d4edda';this.innerText='✓ Kopiert!';setTimeout(()=>{this.style.background='#eee';this.innerText=rt},1500)"
          title="Klicken zum Kopieren">${data.refresh_token || spotify.refreshToken || '(bereits gespeichert)'}</code>
        <script>const rt = document.getElementById('rt').innerText</script>
        <p style="font-size:.85em;color:#666;margin-top:.5rem">
          ↑ Klicken zum Kopieren → in Render unter <code>SPOTIFY_REFRESH_TOKEN</code> einfügen
        </p>
      </div>
      <p><a href="/admin">→ Zum Admin-Bereich</a></p>
      </body></html>`);
  } catch (err) {
    res.status(500).send(`<p>Fehler: ${err.message}</p>`);
  }
});

// ── Admin-Panel ──────────────────────────────────────────────────────────────
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ── Hilfsfunktionen ──────────────────────────────────────────────────────────
function cleanupMap(map, maxAge) {
  if (map.size > 2000) {
    const cutoff = Date.now() - maxAge;
    for (const [id, ts] of map) if (ts < cutoff) map.delete(id);
  }
}

// ── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🎵 Musikwunsch-App läuft auf http://localhost:${PORT}`);
  if (!spotify.isConnected()) console.log(`⚠️  Spotify nicht verbunden → /auth aufrufen`);
});
