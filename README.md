# STRABFAHRT

Karte der Bahnen und Busse im Raum Karlsruhe nach Fahrplan, mit eigener Abfahrtsanzeige je Haltestelle.

- Fahrzeuge bewegen sich auf der Karte (Zeitraffer, Datum und Uhrzeit frei wählbar)
- Filter nach Tram, Bahn, Bus, Sonstige
- Klick auf ein Fahrzeug zeigt den Fahrtverlauf mit Zeiten
- Klick auf eine Haltestelle (ab Zoom 14) oder die Suche zeigt die nächsten Abfahrten, filterbar nach Steig
- Optionale Overlays von OpenRailwayMap (Gleise, Signale, Höchstgeschwindigkeit)
- Favoriten: Haltestellen per Stern speichern, Übersicht mit den nächsten Abfahrten
- In der Nähe: Haltestellen im Umkreis von 1,5 km per Standort (der Browser fragt nach Erlaubnis)
- Linienfilter: einzelne Linien ein- oder ausblenden
- Verbindungssuche von A nach B mit Umstiegen (Fahrplan, ohne Echtzeit), auf der Karte eingezeichnet. Läuft im Browser, auch in der statischen Variante.
- Linienansicht: auf ein Liniensymbol tippen zeigt den Verlauf je Richtung mit allen Halten
- Fahrzeug folgen: die Karte fährt mit dem gewählten Fahrzeug mit
- Barrierefrei: Filter "nur barrierefrei" für Karte und Abfahrten, ♿ in den Abfahrten
- Haltestelle teilen: "Link kopieren" erzeugt einen Link, der direkt die Haltestelle öffnet
- Installierbar als App (PWA) mit Zwischenspeicher für den Offline-Start
- Dunkelmodus (folgt dem System, per Schalter umstellbar) und Handy-Layout mit Bottom-Sheet

- Verspätungsanzeige: Hinter jedem Fahrzeug erscheint ab Zoom 14 ein Zeichen mit Sekunden oder Minuten. Rot heißt zu spät, hellblau zu früh, grün pünktlich (unter 30 Sekunden Abweichung). **Echte Werte gibt es erst mit Echtzeitdaten.** Bis dahin zeigt der Schalter "Demo-Verspätung" erfundene Werte, nur zur Ansicht.

Favoriten, Linienfilter und Theme werden nur im Browser gespeichert (localStorage), nichts geht an den Server.

## Wichtig: Was die App nicht kann

- **Keine Echtzeit.** Alle Positionen und Abfahrten sind Soll-Zeiten aus dem Fahrplan. Verspätungen und Ausfälle werden nicht gezeigt.
- **Streckenführung nur mit Zusatzschritt.** Der KVV-Feed enthält keine Linienverläufe. Ohne `npm run snap:rail` bewegen sich Fahrzeuge in Luftlinie zwischen zwei Haltestellen. Auch mit dem Skript bleiben Busse und Abschnitte ohne passenden Gleisweg in Luftlinie.
- Zeiten sind Berliner Ortszeit. An den beiden Tagen der Zeitumstellung kann der Zeitraffer um eine Stunde abweichen.

## Start

Voraussetzung: Node.js 20 oder neuer, unter Linux/macOS `unzip`.

```bash
npm install
npm run build:data   # lädt den KVV-Feed (ca. 28 MB) und baut data/model.json
npm start            # http://127.0.0.1:3000
```

Weitere Optionen:

```bash
PORT=8080 HOST=0.0.0.0 npm start                       # anderer Port, von außen erreichbar
BBOX="48.90,8.20,49.15,8.65" npm run build:data        # Gebiet: süd,west,nord,ost
node scripts/build-data.mjs --zip pfad/zum/feed.zip    # lokale ZIP-Datei nutzen
node scripts/build-data.mjs --raw pfad/zum/ordner      # bereits entpackter Feed
npm test
```

Den Feed sollte man regelmäßig neu bauen, der KVV aktualisiert ihn nahezu täglich.

### Statische Variante ohne Server (optional)

```bash
npm run build:static   # schreibt dist-static/ (reine Dateien, rechnet im Browser)
```

Der Ordner lässt sich auf jedem Datei-Webspace oder GitHub Pages ablegen. Ohne weitere Option lädt die Variante keine Kartenkacheln und zeigt stattdessen ein schematisches Liniennetz (nötig, wo Fremdbilder gesperrt sind, z. B. in Claude-Artifacts). Mit `npm run build:static -- --tiles` bekommt sie die OpenStreetMap-Karte wie die Server-Variante, dann aber ohne Gleisgeometrie und ohne Standort über HTTP.

### Fahrzeuge auf den Gleisen (optional)

```bash
npm run snap:rail    # lädt Gleise von OpenStreetMap (Overpass-API) und schreibt data/shapes.json
npm start
```

Das Skript legt Tram und Bahn auf die OSM-Gleise. Abschnitte ohne passenden Weg bleiben Luftlinie, Busse ebenfalls. Es braucht Internet und wird dort ausgeführt, wo der Server läuft oder auf deinem Rechner (dann `data/shapes.json` kopieren). Nach jedem `build:data` muss es neu laufen, sonst ignoriert der Server die Datei und gibt eine Warnung aus. Der Standort-Knopf funktioniert nur über `localhost` oder HTTPS. Das Gleis-Matching gilt auch für die statische Variante: `build:static` nimmt `data/shapes.json` mit, wenn sie zum Modell passt.

## Aufbau

| Pfad | Inhalt |
| --- | --- |
| `scripts/build-data.mjs` | Liest GTFS, schneidet auf das Gebiet zu, schreibt `data/model.json` |
| `scripts/build-static.mjs` | Baut `dist-static/` für den Betrieb ohne Server |
| `scripts/snap-rail.mjs` | Legt Tram und Bahn auf OSM-Gleise, schreibt `data/shapes.json` |
| `server/model.mjs` | Fahrplanlogik: Kalender, aktive Fahrten, Abfahrten, Suche |
| `server/index.mjs` | HTTP-Server und JSON-API (`/api/meta`, `/stops`, `/vehicles`, `/departures`, `/search`, `/shapes`) |
| `public/` | Frontend (Leaflet, eigene Canvas-Ebene), kein Build-Schritt |
| `test/` | Tests für Fahrplanlogik, Verbindungssuche und Gleis-Matching |
| `.github/workflows/` | Nächtlicher Auto-Build der Web-Variante |

Der Server arbeitet nur mit eigenen Dateien und baut keine Verbindung zu Fremdsystemen auf. Der Browser lädt Kartenkacheln von OpenStreetMap und, falls aktiviert, von OpenRailwayMap.

## Daten, Lizenzen, Hinweise

- **Fahrplandaten:** Karlsruher Verkehrsverbund (KVV), GTFS, Lizenz CC0. Quelle: <https://www.kvv.de/fahrplan/fahrplaene/open-data.html>. Dieses Projekt ist inoffiziell und steht in keiner Verbindung zum KVV.
- **Karte:** © OpenStreetMap-Mitwirkende (ODbL). Die öffentlichen Kachelserver sind nur für geringe Last gedacht, siehe die [Tile Usage Policy](https://operations.osmfoundation.org/policies/tiles/). Für einen öffentlichen Betrieb mit vielen Nutzern eigenen Kachelserver oder Anbieter verwenden und in `public/app.js` eintragen.
- **Overlays:** OpenRailwayMap, ebenfalls mit eigener Nutzungsrichtlinie.
- **Leaflet:** BSD-2-Clause.
- Die Idee der Fahrplan-Animation und der Haltestellenansicht stammt von bestehenden Projekten. Es wurde kein Code aus ihnen übernommen, alles hier ist eigene Umsetzung.
- Code: MIT, siehe `LICENSE`.
- Ohne Gewähr für Richtigkeit und Vollständigkeit der Daten.

## Nächtlicher Auto-Build (GitHub Actions)

`.github/workflows/pages.yml` baut jede Nacht die Web-Variante mit frischem KVV-Feed neu, legt Bahnen per Overpass auf die OSM-Gleise (Wochen-Cache, bei Fehlschlag Luftlinie) und veröffentlicht auf dem Branch `gh-pages`. Voraussetzung: GitHub Pages steht auf "Deploy from a branch", Branch `gh-pages`, Ordner `/`. Manuell starten: Reiter Actions, Workflow wählen, "Run workflow".

## Echtzeit anschließen

Der Client fragt `GET /api/delays` alle 20 Sekunden ab, sobald `/api/meta` den Wert `"realtime": true` meldet. Antwort: JSON-Objekt von Fahrt-ID (wie in `trips.txt`) auf Verspätung in Sekunden, positiv für zu spät, negativ für zu früh. Die Fahrzeugposition wird dann um diese Verspätung verschoben. Eine Echtzeitquelle ist noch nicht angebunden. Offiziell wäre das die TRIAS-Schnittstelle des KVV nach Abschluss der Nutzungsvereinbarung.

## Mögliche nächste Schritte

- Echtzeit über die offizielle TRIAS-Schnittstelle des KVV für die Abfahrtsanzeige, sobald Zugangsdaten nach der KVV-Nutzungsvereinbarung vorliegen
- Map-Matching für Busse auf das Straßennetz
- Verbindungssuche: Fußwege zu weiter entfernten Haltestellen, spätere und frühere Abfahrten blättern
- Eigene Kachelquelle
