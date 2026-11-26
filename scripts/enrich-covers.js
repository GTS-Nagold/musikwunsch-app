#!/usr/bin/env node

/**
 * Full-Enrichment für Musik-Wunsch-App
 *
 * Liest songs.json, bereichert jeden Song um:
 *   - image:   Album-Cover URL (Spotify CDN)
 *   - uri:     Spotify Track URI (spotify:track:xxx) → für Queue + Preview
 *   - preview: 30s-Vorschau-URL (kann null sein, nicht alle Tracks haben eine)
 *
 * Danach: alle lokalen Songs vollständig, null Spotify-Calls bei Suche/Preview.
 * Abbruchsicher, wiederaufnehmbar, mit Lock.
 *
 * Nutzt separate Spotify-App (COVER_CLIENT_ID/SECRET) falls vorhanden,
 * ansonsten die Live-App (mit Warnung).
 *
 * Usage:
 *   node scripts/enrich-covers.js --all --out data/songs.test.json
 *   node scripts/enrich-covers.js --style walzer --out data/songs.test.json
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs = require('fs');
const path = require('path');
const axios = require('axios');

// ─────────────────────────────────────────────────────────────────────────────
// Konstanten & Parsing
// ─────────────────────────────────────────────────────────────────────────────

const LOCK_PATH = path.join(__dirname, '..', '.enrich-covers.lock');
const CHECKPOINT_INTERVAL = 25; // Alle 25 Songs speichern
const PROGRESS_INTERVAL = 30000; // Alle 30s Fortschritt loggen
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 1000; // Startwert für Exponential Backoff
const REQUEST_DELAY_MS = 1000; // Mindestabstand zwischen Spotify-Calls (1s = ~62 Min für alle Songs)

const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
const isAllStyles = args.includes('--all');
const targetStyle = args.find((a, i) => args[i - 1] === '--style');
const outputFile = args.find((a, i) => args[i - 1] === '--out') || 'data/songs.test.json';

if (!isAllStyles && !targetStyle) {
  console.error('Usage: node scripts/enrich-covers.js [--all|--style STYLE] [--out FILE] [--dry-run]');
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────────────
// Spotify API Setup – Multi-App mit automatischem Wechsel bei 429
// ─────────────────────────────────────────────────────────────────────────────

const SWITCH_THRESHOLD = 3; // Nach X aufeinanderfolgenden 429-Songs → App wechseln

// Alle verfügbaren Credential-Sets laden
const credentialSets = [];
if (process.env.COVER_CLIENT_ID && process.env.COVER_CLIENT_SECRET) {
  credentialSets.push({ clientId: process.env.COVER_CLIENT_ID, clientSecret: process.env.COVER_CLIENT_SECRET, name: 'App 1' });
}
if (process.env.COVER_CLIENT_ID_2 && process.env.COVER_CLIENT_SECRET_2 &&
    process.env.COVER_CLIENT_ID_2 !== 'HIER_EINTRAGEN') {
  credentialSets.push({ clientId: process.env.COVER_CLIENT_ID_2, clientSecret: process.env.COVER_CLIENT_SECRET_2, name: 'App 2' });
}
if (credentialSets.length === 0) {
  // Fallback auf Live-App
  credentialSets.push({ clientId: process.env.SPOTIFY_CLIENT_ID, clientSecret: process.env.SPOTIFY_CLIENT_SECRET, name: 'Live-App ⚠️' });
}

if (!credentialSets[0].clientId) {
  console.error('❌ Fehler: SPOTIFY_CLIENT_ID/SECRET nicht gesetzt');
  process.exit(1);
}

let currentCredIndex = 0;
let consecutive429Songs = 0;
const blockedApps = new Set(); // Apps die bereits 429-geblockt sind
let spotifyAccessToken = null;
let spotifyTokenExpiry = 0;

async function refreshSpotifyToken() {
  const cred = credentialSets[currentCredIndex];
  try {
    const auth = Buffer.from(`${cred.clientId}:${cred.clientSecret}`).toString('base64');
    const response = await axios.post('https://accounts.spotify.com/api/token',
      'grant_type=client_credentials',
      { headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    spotifyAccessToken = response.data.access_token;
    spotifyTokenExpiry = Date.now() + (response.data.expires_in - 60) * 1000;
    console.log(`✅ Spotify Token erneuert (${cred.name})`);
  } catch (err) {
    console.error('❌ Token-Refresh fehlgeschlagen:', err.message);
    throw err;
  }
}

// Gibt false zurück wenn alle Apps blockiert sind → Script soll abbrechen
async function switchToNextApp() {
  // Aktuelle App als blockiert markieren
  blockedApps.add(currentCredIndex);
  console.warn(`🚫 ${credentialSets[currentCredIndex].name} blockiert (429)`);

  // Nächste nicht-blockierte App suchen
  let nextIndex = null;
  for (let i = 1; i <= credentialSets.length; i++) {
    const candidate = (currentCredIndex + i) % credentialSets.length;
    if (!blockedApps.has(candidate)) {
      nextIndex = candidate;
      break;
    }
  }

  if (nextIndex === null) {
    console.error(`\n❌ ALLE ${credentialSets.length} APPS BLOCKIERT (429-Rate-Limit)`);
    console.error(`   Bitte warten bis die Spotify-Sperre abläuft (~22h) und dann neu starten.`);
    console.error(`   Bereits angereicherte Songs sind in songs.test.json gespeichert.`);
    return false;
  }

  console.log(`🔄 Wechsle zu ${credentialSets[nextIndex].name}`);
  currentCredIndex = nextIndex;
  spotifyTokenExpiry = 0;
  consecutive429Songs = 0;
  await refreshSpotifyToken();
  return true;
}

// Gibt { image, uri, preview } zurück, null wenn nicht gefunden, { rateLimited: true } bei 429
async function searchTrack(title, artist, maxRetries = MAX_RETRIES) {
  if (Date.now() > spotifyTokenExpiry) {
    await refreshSpotifyToken();
  }

  const query = `${title} ${artist}`.trim();
  let lastError;
  let wasRateLimited = false;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await axios.get('https://api.spotify.com/v1/search', {
        params: { q: query, type: 'track', limit: 1 },
        headers: { 'Authorization': `Bearer ${spotifyAccessToken}` }
      });
      const track = response.data.tracks?.items?.[0];
      if (track) {
        return {
          image:   track.album?.images?.[0]?.url || null,
          uri:     track.uri || null,
          preview: track.preview_url || null
        };
      }
      return null;
    } catch (err) {
      lastError = err;
      const status = err.response?.status;

      if (status === 429) {
        wasRateLimited = true;
        const backoffMs = BASE_BACKOFF_MS * Math.pow(2, attempt);
        console.warn(`⏳ 429 Rate Limit (Versuch ${attempt + 1}/${maxRetries}) – warte ${backoffMs}ms...`);
        await new Promise(r => setTimeout(r, backoffMs));
        continue;
      }
      if (status === 401) {
        await refreshSpotifyToken();
        continue;
      }
      if (attempt < maxRetries - 1) {
        await new Promise(r => setTimeout(r, 100));
        continue;
      }
    }
  }

  console.warn(`⚠️ Song nicht gefunden nach ${maxRetries} Versuchen: "${query}"`, lastError?.message);
  return wasRateLimited ? { rateLimited: true } : null;
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ─────────────────────────────────────────────────────────────────────────────
// Datei-Operationen
// ─────────────────────────────────────────────────────────────────────────────

function loadSongsDb(filepath) {
  try {
    const content = fs.readFileSync(filepath, 'utf8');
    return JSON.parse(content);
  } catch (err) {
    console.error(`❌ Fehler beim Lesen von ${filepath}:`, err.message);
    process.exit(1);
  }
}

function loadProgress(filepath) {
  try {
    if (!fs.existsSync(filepath)) return {};
    const content = fs.readFileSync(filepath, 'utf8');
    return JSON.parse(content);
  } catch {
    return {};
  }
}

function saveProgress(filepath, data) {
  try {
    fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error(`❌ Fehler beim Speichern von ${filepath}:`, err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

function acquireLock() {
  try {
    // Atomare Datei-Erstellung mit Exclusive-Flag
    // Schlägt fehl wenn Datei schon existiert
    const fd = fs.openSync(LOCK_PATH, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY);
    fs.writeSync(fd, process.pid.toString());
    fs.closeSync(fd);
    console.log('🔒 Lock akquiriert – starte Cover-Enrichment');
    return true;
  } catch (err) {
    if (err.code === 'EEXIST') {
      try {
        const oldPid = fs.readFileSync(LOCK_PATH, 'utf8').trim();
        console.error(`❌ Lock fehlgeschlagen – läuft bereits Prozess PID ${oldPid}`);
      } catch {
        console.error('❌ Lock fehlgeschlagen – läuft bereits ein anderer Prozess');
      }
      process.exit(1);
    }
    console.error('❌ Lock-Fehler:', err.message);
    process.exit(1);
  }
}

function releaseLock() {
  try {
    fs.unlinkSync(LOCK_PATH);
    console.log('🔓 Lock freigegeben');
  } catch (err) {
    console.warn('⚠️  Lock konnte nicht gelöscht werden:', err.message);
  }
}

async function main() {
  // Lock acquisition
  const hasLock = acquireLock();

  try {
    const songsDbPath = path.join(__dirname, '..', 'data', 'songs.json');
    const outputPath = path.join(__dirname, '..', outputFile);
    const checkpointPath = path.join(__dirname, '..', `${outputFile}.checkpoint`);

    console.log(`📖 Quelle: ${songsDbPath}`);
    console.log(`💾 Output: ${outputPath}`);

    const songsDb = loadSongsDb(songsDbPath);
    const existingProgress = loadProgress(outputPath);
    const checkpoint = loadProgress(checkpointPath);

    // Zielstile
    const targetStyles = isAllStyles ? Object.keys(songsDb) : [targetStyle];

    console.log(`🎵 Zielstile: ${targetStyles.join(', ')}`);
    console.log(`✅ Verfügbare Apps: ${credentialSets.map(c => c.name).join(', ')} → Auto-Wechsel bei ${SWITCH_THRESHOLD}× 429`);

    // Token holen
    await refreshSpotifyToken();

    let totalProcessed = 0;
    let totalCovered = 0;
    const startTime = Date.now();

    // Fortschritts-Logger
    const progressInterval = setInterval(() => {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const rate = totalProcessed > 0 ? (totalProcessed / (elapsed / 60)).toFixed(1) : 0;
      console.log(`📊 Fortschritt: ${totalProcessed} Songs, ${totalCovered} mit URI+Cover (${rate} Songs/Min)`);
    }, PROGRESS_INTERVAL);

    // Verarbeite Stile
    for (const style of targetStyles) {
      console.log(`\n🎭 Stil: ${style}`);
      const songs = songsDb[style] || [];
      let styleProcessed = 0;
      let styleCovered = 0;

      for (let i = 0; i < songs.length; i++) {
        const song = songs[i];

        // Überspringen wenn bereits vollständig angereichert (URI vorhanden)
        if (existingProgress[style]?.[i]?.uri) {
          styleCovered++;
          totalCovered++;
          continue;
        }

        // Delay zwischen Calls (429-Prävention, auch beim ersten Song)
        await sleep(REQUEST_DELAY_MS);

        // Spotify-Daten holen
        const result = isDryRun ? null : await searchTrack(song.title, song.artist);

        // 429-Tracking: bei Schwelle App wechseln, bei allen gesperrt → abbrechen
        if (result?.rateLimited) {
          consecutive429Songs++;
          if (consecutive429Songs >= SWITCH_THRESHOLD) {
            const canContinue = await switchToNextApp();
            if (!canContinue) {
              clearInterval(progressInterval);
              saveProgress(outputPath, existingProgress);
              console.error(`\n💾 Fortschritt gespeichert in: ${outputPath}`);
              process.exit(1);
            }
          }
        } else {
          consecutive429Songs = 0;
        }

        // Song im Output mit allen Feldern updaten
        if (!existingProgress[style]) existingProgress[style] = [];
        existingProgress[style][i] = {
          ...song,
          image:   result?.image   || song.image   || null,
          uri:     result?.uri     || song.uri      || null,
          preview: result?.preview || song.preview  || null
        };

        if (result?.uri) styleCovered++;
        totalProcessed++;
        styleProcessed++;

        // Checkpoint alle N Songs
        if (styleProcessed % CHECKPOINT_INTERVAL === 0) {
          saveProgress(outputPath, existingProgress);
          saveProgress(checkpointPath, { style, count: styleProcessed });
          console.log(`  ✅ Checkpoint: ${styleProcessed}/${songs.length} Songs`);
        }
      }

      // Stil fertig → Checkpoint speichern
      saveProgress(outputPath, existingProgress);
      console.log(`  🎯 Fertig: ${styleProcessed} Songs, ${styleCovered} mit URI+Cover (${(styleCovered / styleProcessed * 100).toFixed(1)}%)`);
    }

    clearInterval(progressInterval);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n✨ Fertig!`);
    console.log(`   ${totalProcessed} Songs verarbeitet, ${totalCovered} mit URI+Cover (${(totalCovered / totalProcessed * 100).toFixed(1)}%)`);
    console.log(`   Zeit: ${elapsed}s`);
    console.log(`   Output: ${outputPath}`);

    // Cleanup
    if (fs.existsSync(checkpointPath)) {
      fs.unlinkSync(checkpointPath);
    }

  } finally {
    // Lock freigeben
    if (hasLock) {
      releaseLock();
    }
  }
}

main().catch(err => {
  console.error('❌ Fehler:', err.message);
  process.exit(1);
});
