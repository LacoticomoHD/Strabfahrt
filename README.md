# STRABFAHRT

Karte der Bahnen und Busse im Raum Karlsruhe nach Fahrplan, mit eigener Abfahrtsanzeige je Haltestelle.

- Fahrzeuge bewegen sich auf der Karte (Zeitraffer, Datum und Uhrzeit frei wählbar)
- Filter nach Tram, Bahn, Bus, Sonstige
- Klick auf ein Fahrzeug zeigt den Fahrtverlauf mit Zeiten
- Klick auf eine Haltestelle (ab Zoom 14) oder die Suche zeigt die nächsten Abfahrten, filterbar nach Steig
- Optionale Overlays von OpenRailwayMap (Gleise, Signale, Höchstgeschwindigkeit)

## Wichtig: Was die App nicht kann

- **Keine Echtzeit.** Alle Positionen und Abfahrten sind Soll-Zeiten aus dem Fahrplan. Verspätungen und Ausfälle werden nicht gezeigt.
- **Keine echte Streckenführung.** Der KVV-Feed enthält keine Linienverläufe. Fahrzeuge bewegen sich in Luftlinie zwischen zwei Haltestellen und können daher neben den Gleisen und Straßen laufen.
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

## Aufbau

| Pfad | Inhalt |
| --- | --- |
| `scripts/build-data.mjs` | Liest GTFS, schneidet auf das Gebiet zu, schreibt `data/model.json` |
| `server/model.mjs` | Fahrplanlogik: Kalender, aktive Fahrten, Abfahrten, Suche |
| `server/index.mjs` | HTTP-Server und JSON-API (`/api/meta`, `/stops`, `/vehicles`, `/departures`, `/search`) |
| `public/` | Frontend (Leaflet, eigene Canvas-Ebene), kein Build-Schritt |
| `test/` | Tests für die Fahrplanlogik |

Der Server arbeitet nur mit eigenen Dateien und baut keine Verbindung zu Fremdsystemen auf. Der Browser lädt Kartenkacheln von OpenStreetMap und, falls aktiviert, von OpenRailwayMap.

## Daten, Lizenzen, Hinweise

- **Fahrplandaten:** Karlsruher Verkehrsverbund (KVV), GTFS, Lizenz CC0. Quelle: <https://www.kvv.de/fahrplan/fahrplaene/open-data.html>. Dieses Projekt ist inoffiziell und steht in keiner Verbindung zum KVV.
- **Karte:** © OpenStreetMap-Mitwirkende (ODbL). Die öffentlichen Kachelserver sind nur für geringe Last gedacht, siehe die [Tile Usage Policy](https://operations.osmfoundation.org/policies/tiles/). Für einen öffentlichen Betrieb mit vielen Nutzern eigenen Kachelserver oder Anbieter verwenden und in `public/app.js` eintragen.
- **Overlays:** OpenRailwayMap, ebenfalls mit eigener Nutzungsrichtlinie.
- **Leaflet:** BSD-2-Clause.
- Die Idee der Fahrplan-Animation und der Haltestellenansicht stammt von bestehenden Projekten. Es wurde kein Code aus ihnen übernommen, alles hier ist eigene Umsetzung.
- Code: MIT, siehe `LICENSE`.
- Ohne Gewähr für Richtigkeit und Vollständigkeit der Daten.

## Mögliche nächste Schritte

- Echtzeitdaten, sobald eine frei nutzbare Quelle mit passenden Nutzungsbedingungen geklärt ist (die API ist dafür vorbereitet: Verspätung je Fahrt auf die Zeiten aufschlagen)
- Map-Matching der Fahrzeuge auf OpenStreetMap-Gleise und -Straßen
- Eigene Kachelquelle, Dark Mode, Favoriten-Haltestellen
