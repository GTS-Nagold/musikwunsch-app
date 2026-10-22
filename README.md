# 🎵 Musikwunsch-App für Tanzschulen

Gäste scannen einen QR-Code und wünschen Songs direkt in die Spotify-Queue – ohne Chaos, ohne direkten Spotify-Zugang.

**Funktionen:**
- 15 Tanzstile mit kuratierten Titellisten (aus deinen Spotify-Playlisten)
- Spotify-Freisuche als zweiter Tab
- 60-Sekunden-Cooldown zwischen Wünschen (kein Spam)
- Duplikat-Schutz (Song schon in Queue → Ablehnung mit Hinweis)
- Session-System: QR-Scan = Zeitfenster (z.B. 60 Min.), dann erneut scannen nötig
- Admin-Panel: Party starten/stoppen, QR-Code anzeigen
- Fester QR-Code – einmal ausdrucken, für jede Party verwenden

---

## Voraussetzungen

- Kostenloses Konto bei [GitHub](https://github.com) (zum Speichern des Codes)
- Kostenloses Konto bei [Render](https://render.com) (zum Betreiben der App)
- **Spotify Premium** Account (der Account, der an der Party läuft)
- Spotify läuft auf einem Gerät in der Tanzschule (Handy, Tablet, Laptop)

---

## Schritt 1 – Eigene Kopie auf GitHub erstellen

1. Gehe auf die GitHub-Seite der App (Link vom Ersteller)
2. Klicke oben rechts auf **„Use this template"** → **„Create a new repository"**
3. Gib deinem Repository einen Namen, z.B. `musikwunsch-app`
4. Klicke **„Create repository"**

Du hast jetzt deine eigene Kopie des Codes.

---

## Schritt 2 – Branding anpassen

In deiner GitHub-Kopie: Datei **`config.json`** öffnen und bearbeiten:

```json
{
  "schoolName": "Deine Tanzschule",
  "tagline": "Musikwünsche",
  "primaryColor": "#2f3d7c",
  "accentColor": "#799cc4",
  "backgroundColor": "#f0f4ff"
}
```

- `schoolName` → Name deiner Tanzschule (erscheint im Browser-Tab)
- `tagline` → Überschrift in der App (z.B. „Musikwünsche" oder „Song wünschen")
- `primaryColor` → Hauptfarbe (Buttons, Header) als Hex-Code
- `accentColor` → Akzentfarbe (Links, Untertitel)
- `backgroundColor` → Hintergrundfarbe

**Tipp für Farben:** [coolors.co](https://coolors.co) oder [htmlcolorcodes.com](https://htmlcolorcodes.com) zum Finden von Hex-Codes.

---

## Schritt 3 – Spotify Developer App anlegen

*(Einmalig, ca. 5 Minuten)*

1. Gehe auf → [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard)
2. **Login** mit dem Spotify-Account, der an der Party läuft
3. Klicke **„Create app"**
4. Fülle aus:
   - App name: z.B. `Tanzschule Musikwünsche`
   - App description: beliebig
   - Redirect URI: `https://DEINE-RENDER-URL/callback` *(kommt in Schritt 5)*
   - APIs used: **Web API** ✓
5. Klicke **„Save"**
6. Gehe zu **Settings** → notiere **Client ID** und **Client Secret**

---

## Schritt 4 – App auf Render deployen

1. Gehe auf → [render.com](https://render.com) → **„New +"** → **„Web Service"**
2. Wähle **„Build and deploy from a Git repository"**
3. Verbinde dein GitHub-Konto und wähle dein Repository aus
4. Einstellungen:
   - **Name:** z.B. `musikwunsch-app`
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
   - **Plan:** Free
5. Klicke **„Create Web Service"**

Render gibt dir eine URL, z.B. `https://musikwunsch-app.onrender.com` – notiere sie.

---

## Schritt 5 – Redirect URI in Spotify eintragen

Gehe zurück zur Spotify Developer App (Schritt 3) → **Settings** → **Redirect URIs**:

```
https://DEINE-RENDER-URL/callback
```

*(ersetze `DEINE-RENDER-URL` durch deine echte Render-URL aus Schritt 4)*

Klicke **„Add"** → **„Save"**.

---

## Schritt 6 – Umgebungsvariablen in Render eintragen

In Render → dein Dienst → **„Environment"** → folgende Variablen eintragen:

| Variable | Wert | Beschreibung |
|---|---|---|
| `SPOTIFY_CLIENT_ID` | *(aus Schritt 3)* | Spotify App-ID |
| `SPOTIFY_CLIENT_SECRET` | *(aus Schritt 3)* | Spotify App-Secret |
| `REDIRECT_URI` | `https://DEINE-URL/callback` | Muss exakt passen |
| `APP_URL` | `https://DEINE-URL` | Basis-URL der App |
| `ADMIN_PASSWORD` | *(selbst wählen)* | Passwort für /admin |
| `PARTY_TOKEN` | *(selbst wählen, z.B. `tanzparty-nagold`)* | Fester QR-Code-Schlüssel |

Klicke **„Save Changes"** → Render startet neu.

---

## Schritt 7 – Spotify verbinden (einmalig)

1. Öffne `https://DEINE-URL/auth` im Browser
2. Melde dich mit dem **Party-Spotify-Account** an und bestätige die Berechtigungen
3. Du siehst den **Refresh Token** – klicke drauf zum Kopieren
4. Gehe in Render → **Environment** → neue Variable:
   - Key: `SPOTIFY_REFRESH_TOKEN`
   - Value: *(eingefügter Token)*
5. **„Save Changes"**

Ab jetzt ist Spotify dauerhaft verbunden – dieser Schritt muss nie wiederholt werden.

---

## Schritt 8 – QR-Code drucken

1. Öffne `/admin` → login mit deinem Admin-Passwort
2. Starte eine Testparty → QR-Code erscheint
3. QR-Code abscannen und prüfen, ob die App lädt
4. QR-Code auf deinem Computer als Screenshot speichern oder ausdrucken

**Der QR-Code ist jetzt dauerhaft.** Er ändert sich nie, solange `PARTY_TOKEN` gleich bleibt.

---

## Party-Abend: Ablauf

1. Spotify auf dem Tanzschul-Gerät starten und Musik abspielen
2. `/admin` öffnen → **„Party starten"** (Partyname + Session-Dauer eingeben)
3. QR-Code hängt bereits aus → Gäste können sofort wünschen
4. Nach der Party: **„Party beenden"** → QR-Code funktioniert wieder nicht

---

## Eigene Titellisten einrichten (optional)

Die App enthält bereits kuratierte Titellisten. Um sie durch eigene zu ersetzen:

1. Exportiere deine Spotify-Playlisten als Excel/CSV (z.B. via [Exportify](https://exportify.net))
2. Passe das Script `scripts/export_songs.py` an (Tanzstil-Namen → Playlist-Namen)
3. Führe es aus: `python3 scripts/export_songs.py`
4. Die neue `data/songs.json` in GitHub committen

---

## Technische Details

- **Backend:** Node.js + Express
- **Hosting:** Render.com (kostenloser Plan reicht)
- **Spotify:** OAuth 2.0, Refresh Token (kein tägliches Neu-Login nötig)
- **Sicherheit:** Party-Token im QR-Code, Session-Ablauf, Cooldown, Duplikat-Schutz

---

## Fragen / Probleme

Bei Fragen wende dich an den Entwickler dieser App.
