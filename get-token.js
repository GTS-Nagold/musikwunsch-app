/**
 * Einmaliges Skript um den Spotify Refresh Token zu holen.
 * Schritt 1: node get-token.js
 * Schritt 2: URL im Browser öffnen, Spotify autorisieren
 * Schritt 3: Den "code" aus der Browser-URL hier eintragen, nochmal ausführen
 */
require('dotenv').config();
const https = require('https');

const CLIENT_ID     = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const REDIRECT_URI  = process.env.REDIRECT_URI;

const SCOPES = [
  'user-modify-playback-state',
  'user-read-playback-state',
  'playlist-read-private',
  'playlist-read-collaborative'
].join(' ');

const code = process.argv[2]; // node get-token.js CODE_HIER

if (!code) {
  // Schritt 1: Auth-URL ausgeben
  const params = new URLSearchParams({
    client_id:     CLIENT_ID,
    response_type: 'code',
    redirect_uri:  REDIRECT_URI,
    scope:         SCOPES
  });
  console.log('\n=== SCHRITT 1: Diese URL im Browser öffnen ===\n');
  console.log('https://accounts.spotify.com/authorize?' + params.toString());
  console.log('\nNach dem Login wirst du weitergeleitet zu:');
  console.log(REDIRECT_URI + '?code=LANGER_CODE_HIER&...');
  console.log('\nKopiere nur den Teil nach "code=" bis zum nächsten "&" (oder Ende)');
  console.log('Dann ausführen: node get-token.js DEIN_CODE\n');
} else {
  // Schritt 2: Code gegen Tokens tauschen
  const body = new URLSearchParams({
    grant_type:   'authorization_code',
    code,
    redirect_uri: REDIRECT_URI
  }).toString();

  const auth = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');

  const req = https.request({
    hostname: 'accounts.spotify.com',
    path:     '/api/token',
    method:   'POST',
    headers: {
      'Content-Type':  'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + auth,
      'Content-Length': Buffer.byteLength(body)
    }
  }, res => {
    let data = '';
    res.on('data', c => data += c);
    res.on('end', () => {
      const json = JSON.parse(data);
      if (json.error) {
        console.error('\n❌ Fehler:', json.error, json.error_description);
        console.error('→ Code evtl. abgelaufen (gilt nur 60s) oder falsche Redirect URI.');
        return;
      }
      console.log('\n✅ Erfolgreich! Deinen Refresh Token in .env eintragen:\n');
      console.log('SPOTIFY_REFRESH_TOKEN=' + json.refresh_token);
      console.log('\n(Access Token läuft in 1h ab – der Refresh Token ist dauerhaft)\n');
    });
  });

  req.on('error', e => console.error('Netzwerkfehler:', e.message));
  req.write(body);
  req.end();
}
