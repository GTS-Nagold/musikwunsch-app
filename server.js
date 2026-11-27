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

// ── Tanzstil-Abgleich (für „Jetzt läuft"-Leiste) ─────────────────────────────
// Lesbare Labels pro Tanzstil-Key aus songs.json
const DANCE_LABELS = {
  'walzer': 'Langsamer Walzer', 'wiener-walzer': 'Wiener Walzer', 'tango': 'Tango',
  'foxtrott': 'Foxtrott', 'slowfox': 'Slowfox', 'samba': 'Samba', 'cha-cha': 'Cha Cha Cha',
  'rumba': 'Rumba', 'jive': 'Jive', 'discofox': 'Discofox', 'bachata': 'Bachata',
  'salsa': 'Salsa', 'lindy-hop': 'Lindy Hop', 'blues': 'Blues', 'boogie': 'Boogie Woogie'
};

// Normalisiert Titel/Artist für den Abgleich (Akzente, Klammern, Remaster-Zusätze raus)
function normalizeTrack(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\(.*?\)|\[.*?\]/g, '')
    .replace(/\s*-\s*(remaster|remastered|radio edit|single version|live|mono|stereo|version|edit).*$/i, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Index: normalisierter Titel → [{ dance, artist }]
const songIndex = new Map();
for (const [dance, list] of Object.entries(songsDb)) {
  for (const song of list) {
    const key = normalizeTrack(song.title);
    if (!key) continue;
    if (!songIndex.has(key)) songIndex.set(key, []);
    songIndex.get(key).push({ dance, artist: normalizeTrack(song.artist) });
  }
}

// Ermittelt die Tanzstile zu einem laufenden Song (Titel-Match, Artist zur Entschärfung von Mehrdeutigkeit)
function matchDances(name, artist) {
  const hits = songIndex.get(normalizeTrack(name)) || [];
  if (!hits.length) return [];
  const na = normalizeTrack(artist);
  const naFirst = na.split(' ')[0];
  let filtered = hits;
  if (na) {
    const byArtist = hits.filter(h => h.artist && (h.artist.includes(naFirst) || na.includes(h.artist.split(' ')[0])));
    if (byArtist.length) filtered = byArtist;
  }
  return [...new Set(filtered.map(h => h.dance))];
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const spotify = new SpotifyClient();

// ── In-Memory State ──────────────────────────────────────────────────────────
let activeParty = null;

// Now-Playing-Cache: ein einziger Spotify-Aufruf, geteilt von allen Gästen
let _nowPlayingCache = null;
let _nowPlayingCacheTime = 0;
const NOW_PLAYING_CACHE_MS = 10_000; // 10 Sekunden

async function getCachedPlaybackState() {
  const now = Date.now();
  if (_nowPlayingCache && now - _nowPlayingCacheTime < NOW_PLAYING_CACHE_MS) {
    return _nowPlayingCache;
  }
  _nowPlayingCache = await spotify.getPlaybackState();
  _nowPlayingCacheTime = now;
  return _nowPlayingCache;
}
// { token, name, startedAt, expiresAt|null, sessionDurationMs }

const guestCooldowns  = new Map(); // sessionId → timestamp
const COOLDOWN_MS     = 180_000;  // 3 Minuten zwischen Wünschen

const guestSessions   = new Map(); // sessionId → checkinTimestamp
const expiredSessions = new Set(); // blacklisted sessionIds (müssen QR neu scannen)
const DEFAULT_SESSION_MS = 60 * 60_000; // 60 Minuten Standard

// ── History (RAM + Disk) ─────────────────────────────────────────────────────
const HISTORY_FILE = path.join(__dirname, 'data', 'history.csv');
const HISTORY_HEADER = 'Zeitpunkt,Name,Session-ID,IP,Titel,Artist\n';

const wishHistory = [];
try {
  if (fs.existsSync(HISTORY_FILE)) {
    const lines = fs.readFileSync(HISTORY_FILE, 'utf8').replace(/^﻿/, '').split('\n').slice(1);
    for (const line of lines) {
      if (!line.trim()) continue;
      const [timestamp, name, sessionId, ip, title, artist] = line
        .split(',').map(v => v.replace(/^"|"$/g, '').replace(/""/g, '"'));
      wishHistory.push({ timestamp, name, sessionId, ip, title, artist });
    }
    console.log(`✅ History geladen: ${wishHistory.length} Einträge`);
  } else {
    fs.writeFileSync(HISTORY_FILE, '﻿' + HISTORY_HEADER);
  }
} catch (e) {
  console.warn('⚠️ History konnte nicht geladen werden:', e.message);
}

function appendToHistoryFile(entry) {
  try {
    const line = [entry.timestamp, entry.name, entry.sessionId, entry.ip, entry.title, entry.artist]
      .map(v => `"${String(v || '').replace(/"/g, '""')}"`)
      .join(',') + '\n';
    fs.appendFileSync(HISTORY_FILE, line);
  } catch (e) {
    console.warn('⚠️ History-Schreiben fehlgeschlagen:', e.message);
  }
}

// ── Feedback (Tanzstil-Bewertung laufender Songs) ────────────────────────────
const FEEDBACK_FILE = path.join(__dirname, 'data', 'feedback.csv');
const FEEDBACK_HEADER = 'Zeitpunkt,SessionID,Titel,Artist,SpotifyID,VorgeschlageneTaenze,GewaehlteTaenze,Bewertung\n';

const feedbackData = [];
try {
  if (fs.existsSync(FEEDBACK_FILE)) {
    const lines = fs.readFileSync(FEEDBACK_FILE, 'utf8').replace(/^﻿/, '').split('\n').slice(1);
    for (const line of lines) {
      if (!line.trim()) continue;
      const parts = line.split(',').map(v => v.replace(/^"|"$/g, '').replace(/""/g, '"'));
      if (parts.length >= 7) {
        feedbackData.push({
          timestamp: parts[0], sessionId: parts[1], title: parts[2],
          artist: parts[3], spotifyId: parts[4],
          suggestedDances: parts[5] ? parts[5].split('|') : [],
          chosenDances:    parts[6] ? parts[6].split('|') : [],
          rating:          parts[7] || null
        });
      }
    }
    console.log(`✅ Feedback geladen: ${feedbackData.length} Einträge`);
  } else {
    fs.writeFileSync(FEEDBACK_FILE, '﻿' + FEEDBACK_HEADER);
  }
} catch (e) {
  console.warn('⚠️ Feedback konnte nicht geladen werden:', e.message);
}

function appendToFeedbackFile(entry) {
  try {
    const line = [entry.timestamp, entry.sessionId, entry.title, entry.artist, entry.spotifyId,
      (entry.suggestedDances || []).join('|'), (entry.chosenDances || []).join('|'), entry.rating || '']
      .map(v => `"${String(v || '').replace(/"/g, '""')}"`)
      .join(',') + '\n';
    fs.appendFileSync(FEEDBACK_FILE, line);
  } catch (e) {
    console.warn('⚠️ Feedback-Schreiben fehlgeschlagen:', e.message);
  }
}

// In-Memory: abgelehnte Vorschläge (resettet bei Server-Neustart – ok, da aus CSV neu berechnet)
const rejectedSuggestions = new Set(); // key: "normTitle::normArtist::dance"

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
  res.json({ success: true, expiresAt: Date.now() + duration, partyId: activeParty.startedAt.toString(36) });
});

// App-Modus: Kunden der GregorS-App (Freiseite) checken ohne QR ein, solange eine Party läuft.
// Braucht in Render die Variable APP_KEY (mindestens 16 Zeichen). Gleicher Wert steht in der Freiseite.
app.post('/api/app/checkin', (req, res) => {
  const given = Buffer.from(String(req.body?.key || ''));
  const expected = Buffer.from(process.env.APP_KEY || '');
  if (expected.length < 16 || given.length !== expected.length || !crypto.timingSafeEqual(given, expected))
    return res.status(403).json({ error: 'Nicht berechtigt.' });
  if (activeParty && activeParty.expiresAt && Date.now() > activeParty.expiresAt) activeParty = null;
  if (!activeParty)
    return res.status(403).json({ error: 'Aktuell ist keine Party aktiv. Schau beim nächsten Event wieder rein!', reason: 'no_party' });
  const pid = String(req.body?.pid || '');
  if (!/^[0-9]{1,9}$/.test(pid) || pid === '0') return res.status(400).json({ error: 'Ungültige Kundennummer.' });
  const name = String(req.body?.name || '').replace(/[\u0000-\u001f<>"]/g, '').trim().slice(0, 30);
  const sessionId = 'app_' + pid;
  expiredSessions.delete(sessionId);
  guestSessions.set(sessionId, Date.now());
  res.json({ success: true, token: activeParty.token, sessionId, name, partyId: activeParty.startedAt.toString(36) });
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

// Was läuft gerade? + Tanzempfehlung aus den kuratierten Listen
app.get('/api/now-playing', requireParty, async (req, res) => {
  try {
    const state = await getCachedPlaybackState();
    const item = state?.item;
    if (!item || !item.name) return res.json({ playing: null });
    const name = item.name;
    const artist = (item.artists || []).map(a => a.name).join(', ');
    const danceKeys = matchDances(name, artist);
    res.json({
      playing: { name, artist, isPlaying: !!state.is_playing, spotifyId: item.id || null },
      dances: danceKeys.map(k => ({ key: k, label: DANCE_LABELS[k] || k }))
    });
  } catch {
    res.json({ playing: null });
  }
});

// ── Lokale Suche in songs.json (kein Spotify-Call) ───────────────────────────
function localSearch(query) {
  const norm = s => String(s || '').toLowerCase().normalize('NFD')
    .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const q = norm(query);
  const terms = q.split(' ').filter(t => t.length > 1);
  if (!terms.length) return [];

  const seen = new Map(); // "title::artist" → entry
  for (const [, songs] of Object.entries(songsDb)) {
    for (const song of songs) {
      const key = `${song.title}::${song.artist}`;
      if (seen.has(key)) continue;
      const hay = norm(song.title) + ' ' + norm(song.artist);
      const matchCount = terms.filter(t => hay.includes(t)).length;
      if (matchCount === 0) continue;
      const titleExact = norm(song.title).includes(q) ? 2 : 0;
      seen.set(key, {
        id:      song.uri ? song.uri.split(':')[2] || null : null,
        uri:     song.uri     || null,
        preview: song.preview || null,
        local:   true,
        name:    song.title,
        artist:  song.artist || '',
        image:   song.image  || null,
        _score:  matchCount + titleExact
      });
    }
  }
  return [...seen.values()].sort((a, b) => b._score - a._score).slice(0, 10)
    .map(({ _score, ...rest }) => rest); // _score nicht ans Frontend
}

// Suche: lokal zuerst, Spotify nur als Fallback
app.get('/api/search', requireParty, async (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 2) return res.json([]);

  const local = localSearch(q);

  // Spotify überspringen wenn genug lokale Treffer ODER Account gerade gedrosselt
  if (local.length >= 4 || spotify.isThrottled()) {
    return res.json(local);
  }

  try {
    const remote = await spotify.search(q);
    // Lokale Treffer die nicht in Spotify-Ergebnissen auftauchen, hinten dranhängen
    const remoteKeys = new Set(remote.map(t => normalizeTrack(t.name)));
    const extra = local.filter(l => !remoteKeys.has(normalizeTrack(l.name)));
    return res.json([...remote, ...extra].slice(0, 10));
  } catch (err) {
    console.error('Suche:', err.message);
    return res.json(local); // Fallback auf lokale Ergebnisse
  }
});

// Tanzstil-Feedback zu laufendem Song
app.post('/api/feedback', requireParty, (req, res) => {
  const { title, artist, spotifyId, suggestedDances, chosenDances, rating, sessionId } = req.body;
  if (!title || !sessionId) return res.status(400).json({ error: 'Fehlende Parameter.' });
  const entry = {
    timestamp:       new Date().toISOString(),
    sessionId:       sessionId.slice(-8),
    title:           title.trim().slice(0, 100),
    artist:          (artist || '').trim().slice(0, 100),
    spotifyId:       (spotifyId || '').slice(0, 50),
    suggestedDances: Array.isArray(suggestedDances) ? suggestedDances : [],
    chosenDances:    Array.isArray(chosenDances) ? chosenDances : [],
    rating:          ['up', 'down'].includes(rating) ? rating : null
  };
  feedbackData.push(entry);
  appendToFeedbackFile(entry);
  res.json({ success: true });
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

    // Queue-Position ermitteln: bis zu 3 Versuche à 600ms
    let queuePosition = null;
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        await new Promise(r => setTimeout(r, 600));
        const qi = await spotify.getQueueInfo();
        const idx = qi.queue.findIndex(t => t && t.uri === track.uri);
        if (idx >= 0) { queuePosition = idx + 1; break; }
      }
    } catch {}

    // History loggen
    const entry1 = {
      timestamp: new Date().toISOString(),
      name:      guestName || 'Unbekannt',
      sessionId: sessionId.slice(-6),
      ip:        req.headers['x-forwarded-for']?.split(',')[0].trim() || req.ip || '–',
      title:     track.name,
      artist:    track.artist
    };
    wishHistory.push(entry1);
    appendToHistoryFile(entry1);

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
    const entry2 = {
      timestamp: new Date().toISOString(),
      name:      guestName || 'Unbekannt',
      sessionId: sessionId.slice(-6),
      ip:        req.headers['x-forwarded-for']?.split(',')[0].trim() || req.ip || '–',
      title:     trackName || trackUri,
      artist:    trackArtist || '–'
    };
    wishHistory.push(entry2);
    appendToHistoryFile(entry2);

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
  const playback = await getCachedPlaybackState();
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
  const header = 'Zeitpunkt,Name,Session-ID,IP,Titel,Artist\n';
  const rows = wishHistory.map(h =>
    [h.timestamp, h.name, h.sessionId, h.ip, h.title, h.artist]
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

// ── Admin: Feedback-Vorschläge ───────────────────────────────────────────────

// Aggregierte Vorschläge (ab MIN_VOTES übereinstimmende Votes für einen Tanzstil)
app.get('/admin/feedback/suggestions', requireAdmin, (req, res) => {
  const MIN_VOTES = 1;
  const counts  = new Map(); // key → count
  const meta    = new Map(); // key → { title, artist }
  const ratings = new Map(); // key → { up, down }

  for (const fb of feedbackData) {
    const nt = normalizeTrack(fb.title);
    const na = normalizeTrack(fb.artist);
    for (const dance of fb.chosenDances) {
      const key = `${nt}::${na}::${dance}`;
      if (rejectedSuggestions.has(key)) continue;
      counts.set(key, (counts.get(key) || 0) + 1);
      if (!meta.has(key)) meta.set(key, { title: fb.title, artist: fb.artist });
      if (fb.rating) {
        if (!ratings.has(key)) ratings.set(key, { up: 0, down: 0 });
        ratings.get(key)[fb.rating === 'up' ? 'up' : 'down']++;
      }
    }
  }

  const suggestions = [];
  for (const [key, count] of counts) {
    if (count < MIN_VOTES) continue;
    const parts = key.split('::');
    const dance = parts[2];
    const { title, artist } = meta.get(key);
    const nt = normalizeTrack(title);
    const na = normalizeTrack(artist);
    const alreadyIn = (songsDb[dance] || []).some(s =>
      normalizeTrack(s.title) === nt && normalizeTrack(s.artist) === na
    );
    const r = ratings.get(key) || { up: 0, down: 0 };
    if (!alreadyIn) {
      // spotifyId: letzten bekannten Wert aus den Feedback-Einträgen nehmen
      let spotifyId = '';
      for (const fb of feedbackData) {
        if (normalizeTrack(fb.title) === parts[0] && normalizeTrack(fb.artist) === parts[1] && fb.spotifyId) {
          spotifyId = fb.spotifyId;
          break;
        }
      }
      suggestions.push({ title, artist, dance, votes: count, up: r.up, down: r.down, spotifyId });
    }
  }

  suggestions.sort((a, b) => b.votes - a.votes);
  res.json(suggestions);
});

// Musikwünsche-Liste: wer hat was gewünscht
app.get('/admin/wishes', requireAdmin, (req, res) => {
  const list = [...wishHistory].reverse().map(h => ({
    timestamp: h.timestamp,
    name:      h.name || 'Anonym',
    title:     h.title,
    artist:    h.artist
  }));
  res.json(list);
});

// Alle Ereignisse der Session: Wünsche + alle Bewertungen (chronologisch, neueste zuerst)
app.get('/admin/events', requireAdmin, (req, res) => {
  const events = [];

  for (const h of wishHistory) {
    events.push({ type: 'wish', timestamp: h.timestamp, name: h.name || 'Anonym', title: h.title, artist: h.artist });
  }

  for (const f of feedbackData) {
    const hasDance = (f.chosenDances && f.chosenDances.length > 0) || (f.suggestedDances && f.suggestedDances.length > 0);
    events.push({
      type:    hasDance ? 'suggestion' : 'rating',
      timestamp: f.timestamp,
      title:   f.title,
      artist:  f.artist,
      rating:  f.rating,
      dances:  f.chosenDances?.length ? f.chosenDances : f.suggestedDances
    });
  }

  events.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  res.json(events);
});

// ── Hilfsfunktion: Song in songsDb mit URI/Cover anreichern und speichern ──────
function saveSongsDb() {
  try {
    fs.writeFileSync(path.join(__dirname, 'data', 'songs.json'), JSON.stringify(songsDb, null, 2));
  } catch (e) {
    console.warn('⚠️ songs.json speichern fehlgeschlagen:', e.message);
  }
}

function rebuildSongIndex() {
  songIndex.clear();
  for (const [d, list] of Object.entries(songsDb)) {
    for (const song of list) {
      const key = normalizeTrack(song.title);
      if (!key) continue;
      if (!songIndex.has(key)) songIndex.set(key, []);
      songIndex.get(key).push({ dance: d, artist: normalizeTrack(song.artist) });
    }
  }
}

// Holt URI/Cover/Preview für einen Song und schreibt es zurück in songs.json
// Läuft asynchron im Hintergrund – blockiert nichts.
async function enrichSongInBackground(dance, title, artist, knownSpotifyId) {
  if (spotify.isThrottled()) return; // Bei Sperre sofort aufgeben
  try {
    const query = artist ? `${title} ${artist}` : title;
    const results = await spotify.search(query);
    const track = knownSpotifyId
      ? results.find(r => r.id === knownSpotifyId) || results[0]
      : results[0];
    if (!track) return;

    const songs = songsDb[dance] || [];
    const nt = normalizeTrack(title);
    const na = normalizeTrack(artist || '');
    const idx = songs.findIndex(s =>
      normalizeTrack(s.title) === nt && normalizeTrack(s.artist) === na
    );
    if (idx === -1) return;

    songs[idx] = { ...songs[idx], uri: track.uri, image: track.image || songs[idx].image || null, preview: track.preview || null };
    saveSongsDb();
    console.log(`🎵 Angereichert: "${title}" → URI gespeichert`);
  } catch (e) {
    // Leise scheitern – nächste Party oder Batch-Lauf holt es nach
  }
}

// Vorschlag freigeben: Song in songs.json einfügen + songIndex live neu aufbauen
app.post('/admin/feedback/approve', requireAdmin, (req, res) => {
  const { title, artist, dance, spotifyId } = req.body;
  if (!title || !dance) return res.status(400).json({ error: 'Fehlende Parameter.' });
  if (!songsDb[dance]) songsDb[dance] = [];

  const nt = normalizeTrack(title);
  const na = normalizeTrack(artist || '');
  const exists = songsDb[dance].some(s =>
    normalizeTrack(s.title) === nt && normalizeTrack(s.artist) === na
  );
  if (exists) return res.json({ success: true, message: 'Bereits vorhanden.' });

  // Song einfügen – URI direkt aus spotifyId wenn vorhanden
  const newSong = {
    title:  title.trim(),
    artist: (artist || '').trim(),
    uri:    spotifyId ? `spotify:track:${spotifyId}` : null,
    image:  null,
    preview: null
  };
  songsDb[dance].unshift(newSong);

  try {
    saveSongsDb();
  } catch (e) {
    return res.status(500).json({ error: 'Konnte songs.json nicht speichern: ' + e.message });
  }

  rebuildSongIndex();
  rejectedSuggestions.delete(`${nt}::${na}::${dance}`);
  console.log(`✅ Feedback-Vorschlag freigegeben: "${title}" → ${dance}`);
  res.json({ success: true });

  // Cover + Preview im Hintergrund nachholen (URI haben wir ggf. schon)
  if (!newSong.image || !newSong.preview) {
    enrichSongInBackground(dance, title, artist, spotifyId || null);
  }
});

// Vorschlag ablehnen (In-Memory, resettet bei Neustart)
app.post('/admin/feedback/reject', requireAdmin, (req, res) => {
  const { title, artist, dance } = req.body;
  if (!title || !dance) return res.status(400).json({ error: 'Fehlende Parameter.' });
  rejectedSuggestions.add(`${normalizeTrack(title)}::${normalizeTrack(artist || '')}::${dance}`);
  res.json({ success: true });
});

// Feedback-CSV herunterladen
app.get('/admin/feedback.csv', requireAdmin, (req, res) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="musikwunsch-feedback.csv"');
  res.sendFile(FEEDBACK_FILE);
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
