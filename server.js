require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const SpotifyClient = require('./spotify');

// ── Kuratierte Songlisten (aus Spotify-Export) ──────────────────────────────
const SONGS_DB_PATH = path.join(__dirname, 'data', 'songs.json');
let songsDb = {};
try {
  songsDb = JSON.parse(fs.readFileSync(SONGS_DB_PATH, 'utf8'));
  const total = Object.values(songsDb).reduce((s, arr) => s + arr.length, 0);
  console.log(`✅ Songlisten geladen: ${Object.keys(songsDb).length} Tanzstile, ${total} Songs`);
} catch (e) {
  console.warn('⚠️ songs.json nicht gefunden – kuratierte Listen nicht verfügbar');
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const spotify = new SpotifyClient();

// ── Tanznamen-Filter ────────────────────────────────────────────────────────
const DANCE_NAMES = [
  'walzer', 'tango', 'quickstep', 'foxtrott', 'slowfox', 'slow fox',
  'wiener walzer', 'samba', 'cha cha', 'cha-cha', 'rumba',
  'paso doble', 'paso', 'jive', 'discofox', 'disco fox', 'disco-fox',
  'bachata', 'salsa', 'merengue', 'kizomba', 'zouk',
  'lindy hop', 'lindy-hop', 'west coast swing', 'wcs',
  'zumba', 'polka', 'austanz', 'aus-tanz', 'aus tanz'
];

// Playlisten die NICHT angezeigt werden sollen (egal ob Tanzname drin)
const PLAYLIST_BLOCKLIST = [
  'jesus', 'worship', 'gospel', 'praise', 'kirche', 'gottesdienst',
  'christian', 'church', 'halleluja', 'anbetung', 'gebet', 'psalm'
];

// ── In-Memory State ─────────────────────────────────────────────────────────
let activeParty = null;
// { token, name, startedAt, expiresAt|null }

const guestCooldowns = new Map(); // sessionId → timestamp
const COOLDOWN_MS = 60_000;

// ── Middleware ──────────────────────────────────────────────────────────────

function requireParty(req, res, next) {
  const token = req.query.party || req.headers['x-party-token'];
  if (!activeParty) {
    return res.status(403).json({ error: 'Keine Party aktiv. Bitte den QR-Code an der Tanzschule scannen.' });
  }
  if (activeParty.token !== token) {
    return res.status(403).json({ error: 'Ungültiger Party-Code.' });
  }
  if (activeParty.expiresAt && Date.now() > activeParty.expiresAt) {
    activeParty = null;
    return res.status(403).json({ error: 'Diese Party ist beendet.' });
  }
  next();
}

function requireAdmin(req, res, next) {
  const pwd = req.headers['x-admin-password'] || req.body?.adminPassword || req.query?.pw;
  if (pwd !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Falsches Admin-Passwort.' });
  }
  next();
}

// ── Spotify Auth ────────────────────────────────────────────────────────────

app.get('/auth', (req, res) => {
  const scopes = [
    'user-modify-playback-state',
    'user-read-playback-state',
    'playlist-read-private',
    'playlist-read-collaborative'
  ].join(' ');
  const params = new URLSearchParams({
    client_id: process.env.SPOTIFY_CLIENT_ID,
    response_type: 'code',
    redirect_uri: process.env.REDIRECT_URI,
    scope: scopes
  });
  res.redirect('https://accounts.spotify.com/authorize?' + params);
});

app.get('/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.send(`<p>Fehler: ${error}</p>`);
  try {
    const data = await spotify.exchangeCode(code);
    res.send(`
      <!DOCTYPE html><html><head><meta charset="utf-8">
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <title>Spotify verbunden</title>
      <style>body{font-family:sans-serif;padding:2rem;text-align:center;background:#f0f4ff}
      h2{color:#2f3d7c}.box{background:#fff;border-radius:1rem;padding:1.5rem;display:inline-block;margin:1rem auto;text-align:left}
      code{background:#eee;padding:.2em .5em;border-radius:.3em;font-size:.85em;word-break:break-all}
      a{color:#2f3d7c}</style></head><body>
      <h2>✅ Spotify erfolgreich verbunden!</h2>
      <div class="box">
        <p><strong>Refresh Token (in Render als Env-Variable eintragen):</strong></p>
        <code id="rt" style="display:block;padding:.75rem;margin:.5rem 0;cursor:pointer" onclick="navigator.clipboard.writeText(this.innerText);this.style.background='#d4edda';this.innerText='✓ Kopiert!';setTimeout(()=>{this.style.background='#eee';this.innerText=rt},1500)" title="Klicken zum Kopieren">${data.refresh_token || spotify.refreshToken || '(bereits gespeichert)'}</code>
        <script>const rt = document.getElementById('rt').innerText</script>
        <p style="margin-top:.5rem;font-size:.85em;color:#666">
          ↑ Einmal klicken zum Kopieren, dann in Render unter<br>
          <code>SPOTIFY_REFRESH_TOKEN</code> einfügen und Save klicken.
        </p>
      </div>
      <p><a href="/admin">→ Zum Admin-Bereich</a></p>
      </body></html>
    `);
  } catch (err) {
    res.status(500).send(`<p>Fehler: ${err.message}</p>`);
  }
});

// ── Gast-API ────────────────────────────────────────────────────────────────

// Party-Status prüfen (kein Admin nötig, nur Token)
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

// Tanz-Playlisten laden
app.get('/api/playlists', requireParty, async (req, res) => {
  try {
    const lists = await spotify.getFilteredPlaylists(DANCE_NAMES, PLAYLIST_BLOCKLIST);
    res.json(lists);
  } catch (err) {
    console.error('Playlist-Fehler:', err.message);
    res.status(500).json({ error: 'Spotify nicht erreichbar: ' + err.message });
  }
});

// Songs einer Playlist laden
app.get('/api/playlist/:id/tracks', requireParty, async (req, res) => {
  try {
    const tracks = await spotify.getPlaylistTracks(req.params.id);
    res.json(tracks);
  } catch (err) {
    console.error('Track-Fehler:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Spotify-Suche
app.get('/api/search', requireParty, async (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 2) return res.json([]);
  try {
    const results = await spotify.search(q);
    res.json(results);
  } catch (err) {
    console.error('Such-Fehler:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Kuratierte Songs eines Tanzstils (aus Excel-Export)
app.get('/api/dance/:id/songs', requireParty, (req, res) => {
  const id = req.params.id;
  const songs = songsDb[id];
  if (!songs) return res.status(404).json({ error: 'Tanzstil nicht gefunden' });
  // Maximal 60 Songs pro Anfrage (shuffled beim Start, also immer andere Reihenfolge)
  res.json(songs.slice(0, 60));
});

// Song per Name wünschen (kein URI nötig – Backend sucht Spotify selbst)
app.post('/api/wish-by-name', requireParty, async (req, res) => {
  const { title, artist, sessionId } = req.body;
  if (!title || !sessionId) return res.status(400).json({ error: 'Fehlende Parameter.' });

  // Cooldown prüfen
  const lastWish = guestCooldowns.get(sessionId);
  if (lastWish && Date.now() - lastWish < COOLDOWN_MS) {
    const remaining = Math.ceil((COOLDOWN_MS - (Date.now() - lastWish)) / 1000);
    return res.status(429).json({ error: `Bitte noch ${remaining} Sekunden warten.`, remaining });
  }

  try {
    // Spotify-Suche: Titel + Artist
    const q = artist ? `${title} ${artist}` : title;
    const results = await spotify.search(q);
    if (!results.length) {
      return res.status(404).json({ error: 'Song auf Spotify nicht gefunden.' });
    }
    const track = results[0];

    // Duplikat prüfen
    const duplicate = await spotify.isInQueue(track.uri);
    if (duplicate) {
      return res.status(409).json({ error: 'Dieser Song steht schon in der Queue. 🎵' });
    }

    await spotify.addToQueue(track.uri);
    guestCooldowns.set(sessionId, Date.now());

    if (guestCooldowns.size > 2000) {
      const cutoff = Date.now() - COOLDOWN_MS;
      for (const [id, ts] of guestCooldowns) {
        if (ts < cutoff) guestCooldowns.delete(id);
      }
    }

    res.json({ success: true, matched: { name: track.name, artist: track.artist } });
  } catch (err) {
    console.error('Wish-by-name Fehler:', err.message);
    const msg = err.response?.status === 404
      ? 'Keine aktive Wiedergabe. Bitte Musik auf dem Tanzschul-Gerät starten.'
      : err.message;
    res.status(500).json({ error: msg });
  }
});

// Song wünschen
app.post('/api/wish', requireParty, async (req, res) => {
  const { trackUri, sessionId } = req.body;
  if (!trackUri || !sessionId) {
    return res.status(400).json({ error: 'Fehlende Parameter.' });
  }

  // Cooldown prüfen
  const lastWish = guestCooldowns.get(sessionId);
  if (lastWish && Date.now() - lastWish < COOLDOWN_MS) {
    const remaining = Math.ceil((COOLDOWN_MS - (Date.now() - lastWish)) / 1000);
    return res.status(429).json({ error: `Bitte noch ${remaining} Sekunden warten.`, remaining });
  }

  try {
    // Duplikat prüfen
    const duplicate = await spotify.isInQueue(trackUri);
    if (duplicate) {
      return res.status(409).json({ error: 'Dieser Song steht schon in der Queue. 🎵' });
    }

    // Zur Queue hinzufügen
    await spotify.addToQueue(trackUri);
    guestCooldowns.set(sessionId, Date.now());

    // Map aufräumen wenn zu groß
    if (guestCooldowns.size > 2000) {
      const cutoff = Date.now() - COOLDOWN_MS;
      for (const [id, ts] of guestCooldowns) {
        if (ts < cutoff) guestCooldowns.delete(id);
      }
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Wish-Fehler:', err.message);
    const msg = err.response?.status === 404
      ? 'Keine aktive Wiedergabe auf Spotify gefunden. Bitte Musik auf dem Tanzschul-Gerät starten.'
      : err.message;
    res.status(500).json({ error: msg });
  }
});

// ── Admin-API ───────────────────────────────────────────────────────────────

// Aktuelle Party + Spotify-Status
app.get('/admin/status', requireAdmin, async (req, res) => {
  const playback = await spotify.getPlaybackState();
  res.json({
    spotifyConnected: spotify.isConnected(),
    spotifyPlaying: !!playback?.is_playing,
    spotifyDevice: playback?.device?.name || null,
    party: activeParty
  });
});

// Party starten
app.post('/admin/party/start', requireAdmin, (req, res) => {
  const { name, durationHours } = req.body;
  const token = crypto.randomBytes(3).toString('hex'); // z.B. "a3f9c1"
  activeParty = {
    token,
    name: (name || 'Party').trim(),
    startedAt: Date.now(),
    expiresAt: durationHours ? Date.now() + Number(durationHours) * 3_600_000 : null
  };
  guestCooldowns.clear();
  const url = `${process.env.APP_URL}/?party=${token}`;
  console.log(`🎉 Party gestartet: "${activeParty.name}" – Token: ${token}`);
  res.json({ success: true, party: activeParty, url });
});

// Party stoppen
app.post('/admin/party/stop', requireAdmin, (req, res) => {
  const name = activeParty?.name || '–';
  activeParty = null;
  guestCooldowns.clear();
  console.log(`🛑 Party beendet: "${name}"`);
  res.json({ success: true });
});

// Aktive Playlisten (für Admin-Vorschau)
app.get('/admin/playlists', requireAdmin, async (req, res) => {
  try {
    const lists = await spotify.getFilteredPlaylists(DANCE_NAMES, PLAYLIST_BLOCKLIST);
    res.json(lists);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Debug: Spotify-Account + Scopes + Playlist-Test (temporär offen)
app.get('/debug', async (req, res) => {
  const result = { timestamp: new Date().toISOString() };

  // 1. Spotify Account-Infos + Scopes
  try {
    const me = await spotify.getMe();
    result.account = {
      id: me.id,
      displayName: me.display_name,
      email: me.email,
      product: me.product  // "premium" oder "free"
    };
  } catch (err) {
    result.account = { error: err.response?.data?.error?.message || err.message };
  }

  // 2. Alle gefilterten Playlisten anzeigen (IDs + ob privat)
  try {
    const all = await spotify.getAllPlaylists();
    result.allPlaylists = all
      .filter(p => p?.name)
      .map(p => ({
        id: p.id,
        name: p.name,
        public: p.public,
        collaborative: p.collaborative,
        owner: p.owner?.id,
        tracks: p.tracks?.total
      }));

    const DANCE_FILTER = DANCE_NAMES;
    result.dancePlaylists = result.allPlaylists.filter(p =>
      DANCE_FILTER.some(d => p.name.toLowerCase().includes(d.toLowerCase()))
    );
  } catch (err) {
    result.playlistsError = err.response?.data?.error?.message || err.message;
  }

  // 3. Track-Test: einmal fremde Playlist, einmal eigene Playlist
  const me = result.account?.id;
  const externalPl = result.dancePlaylists?.find(p => p.owner !== me);
  const ownPl = result.dancePlaylists?.find(p => p.owner === me);

  result.trackTests = [];
  for (const pl of [externalPl, ownPl].filter(Boolean)) {
    const test = { playlistId: pl.id, playlistName: pl.name, owner: pl.owner, isOwnPlaylist: pl.owner === me };
    try {
      const r = await spotify.debugPlaylist(pl.id);
      test.success = true;
      test.result = r;
    } catch (err) {
      test.success = false;
      test.status = err.response?.status;
      test.error = err.response?.data?.error?.message || err.message;
    }
    result.trackTests.push(test);
  }

  res.json(result);
});

// ── Admin HTML direkt ausliefern ────────────────────────────────────────────
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ── Start ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🎵 Musikwunsch-App läuft auf http://localhost:${PORT}`);
  if (!spotify.isConnected()) {
    console.log(`⚠️  Spotify noch nicht verbunden → http://localhost:${PORT}/auth aufrufen`);
  }
});
