#!/usr/bin/env node
/**
 * Kürzt songs.json auf maximal LIMIT Songs pro Stil.
 * Stile die bereits angereicherte Songs haben (uri vorhanden) bleiben unverändert.
 *
 * Usage: node scripts/trim-songs.js [--limit 100] [--dry-run]
 */

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
const limitArg = args.find((a, i) => args[i - 1] === '--limit');
const LIMIT = limitArg ? parseInt(limitArg) : 100;

const songsPath = path.join(__dirname, '..', 'data', 'songs.json');
const songs = JSON.parse(fs.readFileSync(songsPath, 'utf8'));

console.log(`✂️  Trim-Script – Limit: ${LIMIT} Songs/Stil${isDryRun ? ' (DRY RUN)' : ''}\n`);

let totalBefore = 0;
let totalAfter = 0;

for (const [style, list] of Object.entries(songs)) {
  const enrichedCount = list.filter(s => s && s.uri).length;
  const hasEnriched = enrichedCount > 0;
  totalBefore += list.length;

  if (hasEnriched || list.length <= LIMIT) {
    const reason = hasEnriched ? `bereits angereichert (${enrichedCount} URIs)` : `≤ ${LIMIT} Songs`;
    console.log(`✅ ${style.padEnd(16)} ${list.length} Songs – behalten (${reason})`);
    totalAfter += list.length;
  } else {
    console.log(`✂️  ${style.padEnd(16)} ${list.length} → ${LIMIT} Songs`);
    if (!isDryRun) songs[style] = list.slice(0, LIMIT);
    totalAfter += LIMIT;
  }
}

console.log(`\nGesamt: ${totalBefore} → ${totalAfter} Songs`);

if (!isDryRun) {
  fs.writeFileSync(songsPath, JSON.stringify(songs, null, 2));
  console.log(`💾 songs.json gespeichert.`);
} else {
  console.log(`ℹ️  Dry Run – nichts gespeichert. Ohne --dry-run ausführen zum Anwenden.`);
}
