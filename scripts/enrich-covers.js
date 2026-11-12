#!/usr/bin/env node

/**
 * Cover-Enrichment für Musik-Wunsch-App
 *
 * Liest songs.json, bereichert jeden Song um Album-Cover (image-URL),
 * speichert zu songs.test.json. Abbruchsicher, wiederaufnehmbar, mit Lock.
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
// Spotify API Setup
// ─────────────────────────────────────────────────────────────────────────────

const spotifyConfig = {
  clientId: process.env.COVER_CLIENT_ID || process.env.SPOTIFY_CLIENT_ID,
  clientSecret: process.env.COVER_CLIENT_SECRET || process.env.SPOTIFY_CLIENT_SECRET,
  usesSeparateApp: !!(process.env.COVER_CLIENT_ID && process.env.COVER_CLIENT_SECRET),
};

if (!spotifyConfig.clientId || !spotifyConfig.clientSecret) {
  console.error('❌ Fehler: SPOTIFY_CLIENT_ID/SECRET nicht gesetzt');
  process.exit(1);
}

let spotifyAccessToken = null;
let spotifyTokenExpiry = 0;

async function refreshSpotifyToken() {
  try {
    const auth = Buffer.from(`${spotifyConfig.clientId}:${spotifyConfig.clientSecret}`).toString('base64');
    const response = await axios.post('https://accounts.spotify.com/api/token',
      'grant_type=client_credentials',
      {
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );
    spotifyAccessToken = response.data.access_token;
    spotifyTokenExpiry = Date.now() + (response.data.expires_in - 60) * 1000;
    console.log(`✅ Spotify Token erneuert (Kontingent: ${spotifyConfig.usesSeparateApp ? 'SEPARATE App' : '⚠️ LIVE App'})`);
  } catch (err) {
    console.error('❌ Token-Refresh fehlgeschlagen:', err.message);
    throw err;
  }
}

async function searchTrack(title, artist, maxRetries = MAX_RETRIES) {
  if (Date.now() > spotifyTokenExpiry) {
    await refreshSpotifyToken();
  }

  const query = `${title} ${artist}`.trim();
  let lastError;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await axios.get('https://api.spotify.com/v1/search', {
        params: {
          q: query,
          type: 'track',
          limit: 1
        },
        headers: {
          'Authorization': `Bearer ${spotifyAccessToken}`
        }
      });

      const track = response.data.tracks?.items?.[0];
      if (track?.album?.images?.[0]?.url) {
        return track.album.images[0].url;
      }
      return null;
    } catch (err) {
      lastError = err;
      const status = err.response?.status;

      if (status === 429) {
        // Rate limit – Exponential Backoff
        const backoffMs = BASE_BACKOFF_MS * Math.pow(2, attempt);
        console.warn(`⏳ 429 Rate Limit (Versuch ${attempt + 1}/${maxRetries}) – warte ${backoffMs}ms...`);
        await new Promise(r => setTimeout(r, backoffMs));
        continue;
      }

      if (status === 401) {
        // Token ungültig
        await refreshSpotifyToken();
        continue;
      }

      // Andere Fehler: retry
      if (attempt < maxRetries - 1) {
        await new Promise(r => setTimeout(r, 100));
        continue;
      }
    }
  }

  // Alle Retries aufgebraucht
  console.warn(`⚠️ Song nicht gefunden nach ${maxRetries} Versuchen: "${query}"`, lastError?.message);
  return null;
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
    console.log(`${spotifyConfig.usesSeparateApp ? '✅' : '⚠️'} Spotify-App: ${spotifyConfig.usesSeparateApp ? 'SEPARATE (sicher)' : 'LIVE (riskant – warnung!)'}`);

    if (!spotifyConfig.usesSeparateApp) {
      console.warn('⚠️  WARNUNG: Nutze die Live-App! Separate App empfohlen – siehe Anleitung.');
    }

    // Token holen
    await refreshSpotifyToken();

    let totalProcessed = 0;
    let totalCovered = 0;
    const startTime = Date.now();

    // Fortschritts-Logger
    const progressInterval = setInterval(() => {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const rate = totalProcessed > 0 ? (totalProcessed / (elapsed / 60)).toFixed(1) : 0;
      console.log(`📊 Fortschritt: ${totalProcessed} Songs, ${totalCovered} mit Cover (${rate} Songs/Min)`);
    }, PROGRESS_INTERVAL);

    // Verarbeite Stile
    for (const style of targetStyles) {
      console.log(`\n🎭 Stil: ${style}`);
      const songs = songsDb[style] || [];
      let styleProcessed = 0;
      let styleCovered = 0;

      for (let i = 0; i < songs.length; i++) {
        const song = songs[i];

        // Überspringen wenn bereits Cover vorhanden
        if (existingProgress[style]?.[i]?.image) {
          styleCovered++;
          totalCovered++;
          continue;
        }

        // Cover suchen
        const imageUrl = isDryRun ? null : await searchTrack(song.title, song.artist);

        // Song im Output mit image-Feld updaten
        if (!existingProgress[style]) existingProgress[style] = [];
        existingProgress[style][i] = {
          ...song,
          image: imageUrl || null
        };

        if (imageUrl) styleCovered++;
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
      console.log(`  🎯 Fertig: ${styleProcessed} Songs, ${styleCovered} mit Cover (${(styleCovered / styleProcessed * 100).toFixed(1)}%)`);
    }

    clearInterval(progressInterval);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n✨ Fertig!`);
    console.log(`   ${totalProcessed} Songs verarbeitet, ${totalCovered} mit Cover (${(totalCovered / totalProcessed * 100).toFixed(1)}%)`);
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
