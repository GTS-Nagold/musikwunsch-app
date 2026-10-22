# 🎵 Musikwunsch App – Claude Skill

Dieses File ist dein Assistent. Öffne es in **Claude Code** und sage:
**„Führe den Setup-Skill aus"**

Claude übernimmt dann die Einrichtung – du beantwortest ein paar Fragen,
klickst an drei Stellen im Browser, und danach läuft deine App.

---

## TEIL 1 · Ersteinrichtung (einmalig, ca. 20 Min.)

> **Claude-Anweisung:** Führe diesen Teil Schritt für Schritt aus.
> Stelle dem Nutzer die Fragen nacheinander. Warte immer auf die Antwort,
> bevor du weitermachst. Erkläre kurz was du gerade tust.

---

### Schritt 1 · Infos sammeln

Stelle diese Fragen einzeln und speichere die Antworten:

1. „Wie heißt deine Tanzschule?" → `SCHOOL_NAME`
2. „Welche Hauptfarbe soll die App haben? (Hex-Code wie #2f3d7c, oder Enter für Blau)" → `PRIMARY_COLOR` (Standard: `#2f3d7c`)
3. „Welche Akzentfarbe? (oder Enter für Hellblau)" → `ACCENT_COLOR` (Standard: `#799cc4`)
4. „Wähle ein Admin-Passwort für die Admin-Seite (nur du kennst es)" → `ADMIN_PASSWORD`
5. „Wähle einen QR-Code-Schlüssel (z.B. tanzparty-berlin – wird Teil der App-URL)" → `PARTY_TOKEN`

---

### Schritt 2 · Projekt einrichten

```bash
# Projektordner anlegen (Claude führt das aus)
cd ~/projects 2>/dev/null || mkdir ~/projects && cd ~/projects
git clone https://github.com/GTS-Nagold/musikwunsch-app.git tanzschule-musikwunsch
cd tanzschule-musikwunsch
```

Dann `config.json` mit den Angaben aus Schritt 1 befüllen:

```json
{
  "schoolName": "[SCHOOL_NAME]",
  "tagline": "Musikwünsche",
  "primaryColor": "[PRIMARY_COLOR]",
  "accentColor": "[ACCENT_COLOR]",
  "backgroundColor": "#f0f4ff"
}
```

Dann `.env` anlegen:

```
SPOTIFY_CLIENT_ID=wird_in_schritt_4_eingetragen
SPOTIFY_CLIENT_SECRET=wird_in_schritt_4_eingetragen
SPOTIFY_REFRESH_TOKEN=wird_in_schritt_6_eingetragen
REDIRECT_URI=wird_in_schritt_5_eingetragen
APP_URL=wird_in_schritt_5_eingetragen
ADMIN_PASSWORD=[ADMIN_PASSWORD]
PARTY_TOKEN=[PARTY_TOKEN]
PORT=3000
```

---

### Schritt 3 · Spotify Developer App anlegen (Browser, 5 Min.)

> **Claude-Anweisung:** Erkläre dem Nutzer jeden Klick genau.
> Warte bis er bestätigt, dass er den Schritt abgeschlossen hat.

Sage dem Nutzer:

1. Öffne → **developer.spotify.com/dashboard** (mit dem Spotify-Account, der an der Party läuft)
2. Klicke **„Create app"**
3. Fülle aus:
   - App name: `[SCHOOL_NAME] Musikwünsche`
   - Redirect URI: `https://PLATZHALTER/callback` (wird gleich ersetzt)
   - APIs used: **Web API** ✓
4. Klicke **„Save"**
5. Gehe zu **Settings** und notiere **Client ID** und **Client Secret**

Frage dann: „Hast du Client ID und Client Secret? Bitte beide eingeben."
→ `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET` in `.env` eintragen.

---

### Schritt 4 · Auf Render deployen (Browser, 5 Min.)

> **Claude-Anweisung:** Führe den Nutzer durch jeden Schritt.

Sage dem Nutzer:

1. Öffne → **render.com** → Konto erstellen (kostenlos)
2. **„New +"** → **„Web Service"**
3. Wähle **„Deploy from existing code"** → dann **„Public Git repository"**
4. Füge ein: `https://github.com/GTS-Nagold/musikwunsch-app`
5. Einstellungen:
   - Name: `[SCHOOL_NAME]-musikwunsch` (Kleinbuchstaben, Bindestriche)
   - Runtime: **Node**
   - Build Command: `npm install`
   - Start Command: `node server.js`
   - Plan: **Free**
6. Klicke **„Create Web Service"**
7. Warte bis der erste Deploy durch ist (~2 Min.)
8. Notiere deine **Render-URL** (z.B. `https://tanzschule-berlin-musikwunsch.onrender.com`)

Frage dann: „Was ist deine Render-URL?"
→ `APP_URL` in `.env` eintragen

---

### Schritt 5 · Redirect URI eintragen + Umgebungsvariablen in Render

Sage dem Nutzer:

**Erst Spotify:**
1. → developer.spotify.com/dashboard → deine App → Settings → Redirect URIs
2. Eintragen: `[APP_URL]/callback`
3. „Add" → „Save"

**Dann Render:**
1. → render.com → dein Dienst → **„Environment"**
2. Folgende Variablen eintragen:

| Variable | Wert |
|---|---|
| `SPOTIFY_CLIENT_ID` | *(aus Schritt 3)* |
| `SPOTIFY_CLIENT_SECRET` | *(aus Schritt 3)* |
| `REDIRECT_URI` | `[APP_URL]/callback` |
| `APP_URL` | `[APP_URL]` |
| `ADMIN_PASSWORD` | `[ADMIN_PASSWORD]` |
| `PARTY_TOKEN` | `[PARTY_TOKEN]` |

3. **„Save Changes"** → Render startet neu

---

### Schritt 6 · Spotify verbinden (einmalig)

Sage dem Nutzer:

1. Öffne `[APP_URL]/auth` im Browser
2. Melde dich mit dem **Party-Spotify-Account** an
3. Bestätige die Berechtigungen
4. Du siehst einen langen Token – klicke drauf zum Kopieren
5. Gehe in Render → Environment → neue Variable:
   - Key: `SPOTIFY_REFRESH_TOKEN`
   - Value: *(eingefügter Token)*
6. „Save Changes"

Frage dann: „Hat es geklappt – hast du den Token eingetragen?"

---

### Schritt 7 · Testen & QR-Code drucken

```bash
# Test: Läuft die App?
curl -s [APP_URL]/api/party/status
# Erwartete Antwort: {"active":false,"reason":"no_party"}
```

Dann sage dem Nutzer:
1. Öffne `[APP_URL]/admin`
2. Passwort eingeben → **„Party starten"**
3. QR-Code erscheint → Screenshot machen → ausdrucken → laminieren

**Glückwunsch – die App läuft! 🎉**

QR-Code-URL für immer: `[APP_URL]/?party=[PARTY_TOKEN]`

---

## TEIL 2 · Party-Abend (laufender Betrieb)

> **Claude-Anweisung:** Für diesen Teil die Credentials aus `.env` lesen
> und die entsprechenden API-Calls ausführen.

```bash
# Setup
source ~/projects/tanzschule-musikwunsch/.env
```

### Queue anzeigen

```bash
curl -s "$APP_URL/admin/queue" \
  -H "x-admin-password: $ADMIN_PASSWORD" | python3 -c "
import json, sys
d = json.load(sys.stdin)
now = d.get('currentlyPlaying')
print('▶ Jetzt:', now['name'] + ' – ' + now['artist'] if now else '(nichts)')
print()
for i, t in enumerate(d.get('queue', []), 1):
    print(f'  {i:2}. {t[\"name\"]} – {t[\"artist\"]}')
"
```

### Party starten

```bash
curl -s -X POST "$APP_URL/admin/party/start" \
  -H "x-admin-password: $ADMIN_PASSWORD" \
  -H "Content-Type: application/json" \
  -d "{\"name\": \"Tanzparty\", \"sessionDurationMinutes\": 60}" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print('✅', d['party']['name'], '| URL:', d['url'])"
```

### Party stoppen

```bash
curl -s -X POST "$APP_URL/admin/party/stop" \
  -H "x-admin-password: $ADMIN_PASSWORD" && echo "🛑 Party beendet"
```

### App-Status prüfen

```bash
curl -s "$APP_URL/admin/status" \
  -H "x-admin-password: $ADMIN_PASSWORD" | python3 -c "
import json, sys
d = json.load(sys.stdin)
print('Spotify:', '✅ verbunden' if d['spotifyConnected'] else '❌ nicht verbunden')
print('Wiedergabe:', '▶ ' + (d['spotifyDevice'] or '?') if d['spotifyPlaying'] else '⏸ keine')
p = d.get('party')
print('Party:', p['name'] if p else 'keine aktiv')
"
```

---

## TEIL 3 · Farben & Branding ändern

> **Claude-Anweisung:** config.json bearbeiten, dann committen und pushen.

```bash
# config.json anzeigen
cat ~/projects/tanzschule-musikwunsch/config.json
```

Nach dem Bearbeiten:

```bash
cd ~/projects/tanzschule-musikwunsch
git add config.json
git commit -m "Branding aktualisiert"
git push
```

Render deployt automatisch in ~1 Minute.

**Oder sofort live** (bis zum nächsten Neustart):

```bash
curl -s -X POST "$APP_URL/admin/config" \
  -H "x-admin-password: $ADMIN_PASSWORD" \
  -H "Content-Type: application/json" \
  -d '{"primaryColor": "#NEUEFARBE"}'
```
