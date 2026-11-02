# STRABFAHRT

Karte der Bahnen und Busse im Raum Karlsruhe nach Fahrplan, mit eigener Abfahrtsanzeige je Haltestelle.

- Fahrzeuge bewegen sich auf der Karte (Zeitraffer, Datum und Uhrzeit frei wählbar)
- Filter nach Tram, Bahn, Fernverkehr, Bus, Sonstige
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
- Mein Weg: eine Strecke speichern (z. B. Zuhause nach Arbeit), die Favoriten-Ansicht zeigt die nächsten Verbindungen. In der Verbindungssuche blätterst du mit "Früher" und "Später".
- Route teilen: "Link kopieren" in der Verbindungssuche öffnet beim Empfänger dieselbe Suche
- Takt-Karte: Schalter "Takt" färbt Haltestellen nach Abfahrten pro Stunde (12+, 6 bis 11, 3 bis 5, 1 bis 2)
- Erreichbarkeit: In der Haltestellenansicht "Wohin komme ich in 15/30/45/60 min" färbt erreichbare Haltestellen nach Fahrzeit, mit Umstiegen und Fußwegen
- Vollbild-Tafel: "Als Tafel öffnen" zeigt eine Haltestelle groß wie eine Anzeigetafel (Link `#tafel=<Haltestellen-ID>`), hält den Bildschirm wach, wenn der Browser das erlaubt
- Adressen als Start und Ziel: Im Feld "Adresse suchen" antippen. Der Weg zur und von der Haltestelle wird als Fußweg eingerechnet (bis 1 km, 1,2 m/s). Die Adresssuche nutzt Nominatim von OpenStreetMap, nur auf Klick und mit einer Anfrage pro Suche, siehe die [Nutzungsrichtlinie](https://operations.osmfoundation.org/policies/nominatim/). In Umgebungen, die fremde Anfragen sperren (z. B. Claude-Artifacts), ist sie nicht verfügbar.
- Reisezeit über den Tag: Diagramm für eine Strecke, wann sich das Losgehen lohnt (Gesamtzeit mit Warten, Antippen sucht ab dieser Uhrzeit)
- Mein Weg wechselt automatisch zwischen Hin- und Rückweg (vor 12 Uhr Hinweg), mit Knopf zum Umkehren
- Kalender: "In Kalender" speichert eine Verbindung als `.ics`-Datei (Uhrzeiten ohne Zeitzone, gelten in der Ortszeit des Kalenders)
- Hinweise: Warnung, wenn das Datum außerhalb des Fahrplans liegt, der Fahrplan bald endet oder die Daten älter als 3 Tage sind. Umleitungen und Schienenersatzverkehr sind mit ⚠ markiert.
- Fahrtrichtung als Pfeil am Fahrzeugschild, optional Spuren (Schweif hinter den Fahrzeugen)
- Filter "Fahrrad nicht verboten": Der KVV-Feed kennt bei Fahrrädern nur "unbekannt" oder "nicht erlaubt", nie "erlaubt". Der Filter blendet deshalb nur ausdrückliche Verbote aus.
- Letzte Verbindung: In der Verbindungssuche zeigt "Letzte Verbindung" die spätestmögliche Abfahrt vor der nächtlichen Betriebspause (mindestens 90 Minuten ohne Abfahrt). Der Frühverkehr des Folgetags zählt nicht.
- Barrierefrei reisen: Schalter in der Verbindungssuche, nutzt nur Fahrten mit ♿ und meidet Halte, die laut Feed nicht stufenfrei sind. **Die Haltestellen-Angabe ist im Feed dünn:** nur etwa 1 % der Halte sind als stufenfrei, rund 11 % als nicht stufenfrei markiert, der Rest hat keine Angabe und gilt als nutzbar. Die Haltestellenansicht zeigt, was der Feed zu den Steigen sagt.
- Umleitungen heute: Liste der Linien mit Umleitungen oder Ersatzverkehr, abgeleitet aus den Zielangaben im Fahrplan. Keine Störungsmeldungen, die stehen auf kvv.de.
- Haltestellengruppen: In den Favoriten mehrere Haltestellen unter einem Namen bündeln (z. B. "Zuhause"). Die Abfahrten aller Haltestellen erscheinen zusammen nach Zeit sortiert.
- Tafel mit mehreren Haltestellen (bis 6) und QR-Code, der die Tafel auf einem zweiten Gerät öffnet. Link: `#tafel=<ID>~<ID>`.
- Optionen-Menü: Filter und Schalter stehen hinter "Optionen" in der unteren Leiste (am Handy zunächst eingeklappt).
- Akkusparmodus: weniger Bilder pro Sekunde und geringere Auflösung. Schaltet sich bei "Bewegung reduzieren" im Betriebssystem von selbst ein. Bei Pause wird ohnehin seltener gezeichnet.
- Zeitleiste (Schieber für die Uhrzeit) und "Nacht": springt auf 01:30 der kommenden Nacht und zeigt, welche Linien dann fahren
- Dunkelmodus (folgt dem System, per Schalter umstellbar) und Handy-Layout mit Bottom-Sheet

- Verspätungsanzeige: Hinter jedem Fahrzeug erscheint ab Zoom 14 ein Zeichen mit Sekunden oder Minuten. Rot heißt zu spät, hellblau zu früh, grün pünktlich (unter 30 Sekunden Abweichung). Die Werte kommen live aus dem Echtzeitstream, wenn der Server läuft (siehe Echtzeit). Der Schalter "Demo-Verspätung" zeigt erfundene Werte und überdeckt dann die echten.

Favoriten, Linienfilter und Theme werden nur im Browser gespeichert (localStorage), nichts geht an den Server.

## Prüfung vor dem Veröffentlichen

`npm run check:data` prüft das gebaute Modell (Mindestanzahl Fahrten, Verkehr am heutigen Tag, Verbindung Hauptbahnhof nach Durlach). Der Workflow veröffentlicht nur, wenn Bau, Tests und Prüfung durchlaufen. `build:data` bricht selbst ab, wenn weniger als 20.000 KVV-Fahrten ankommen (`STRAB_MIN_TRIPS`).

Zeitumstellung: An den beiden Umstellungstagen liegen frühe Fahrten nach GTFS-Regel eine Stunde neben der Wanduhr. Das Modell korrigiert das.

## Datenquellen

| Feed | Inhalt | Lizenz |
| --- | --- | --- |
| KVV | Tram, Bus, S-Bahn im KVV-Gebiet | CC0 |
| gtfs.de Fernverkehr | ICE, IC, EC und andere Fernzüge (DB und Partner) | CC BY 4.0, Daten von DELFI e.V. |
| gtfs.de Regionalverkehr | RE, RB, IRE, weitere S-Bahnen und Privatbahnen | CC BY 4.0, Daten von DELFI e.V. |
| gtfs.de Nahverkehr | nur zur Zuordnung der Echtzeit, nicht angezeigt | CC BY 4.0, Daten von DELFI e.V. |
| gtfs.de Echtzeit | Verspätungen, Ausfälle, Meldungen | CC BY-SA 4.0 |

Die Quellenangaben stehen in der App unten in der Leiste und auf der Tafel. Die kostenlosen gtfs.de-Feeds enthalten nur die **nächsten 30 Tage**, der nächtliche Build hält sie aktuell. Für Daten darüber hinaus zeigt die App einen Hinweis und es fahren nur KVV-Linien. Fehlt ein gtfs.de-Feed beim Bauen (z. B. kein Netz), wird er übersprungen. Mit `npm run build:data -- --feeds kvv` baust du nur KVV.

Doppelungen: Der Regionalfeed enthält auch die S-Bahnen, die schon im KVV-Feed stehen. Linien mit gleichem Namen werden aus dem Regionalfeed nicht übernommen. Haltestellen mit gleichem Namen (z. B. "Karlsruhe Hbf") und höchstens 250 m Abstand werden zu einer Station zusammengelegt, sodass Abfahrten und Umstiege am Hauptbahnhof zusammenpassen.

**Güterzüge gibt es nicht:** Für Güterverkehr existieren keine offenen Fahrplan- oder Positionsdaten. Der Schalter "Gleise" (OpenRailwayMap) zeigt aber die Infrastruktur, auf der sie fahren.

## Wichtig: Was die App nicht kann

- **Fernzüge sind im Gebiet nur grob eingezeichnet.** Gespeichert wird der Teil im Kartengebiet plus der nächste Halt davor und danach. Ein ICE nach Basel bewegt sich deshalb in Luftlinie zum nächsten Halt außerhalb, ohne Gleisverlauf dazwischen.
- **Echtzeit nur mit laufendem Server** (siehe unten). Ohne ihn sind alle Zeiten Soll-Zeiten. Positionen sind immer geschätzt, nie GPS.
- **Streckenführung nur mit Zusatzschritt.** Der KVV-Feed enthält keine Linienverläufe. Ohne `npm run snap:rail` bewegen sich Fahrzeuge in Luftlinie zwischen zwei Haltestellen. Auch mit dem Skript bleiben Busse und Abschnitte ohne passenden Gleisweg in Luftlinie.
- Zeiten sind Berliner Ortszeit. An den beiden Tagen der Zeitumstellung kann der Zeitraffer um eine Stunde abweichen.

## Schnellstart in Visual Studio Code

1. [Node.js](https://nodejs.org) 20 oder neuer installieren (einmalig).
2. In VS Code: `Strg+Umschalt+P`, "Git: Clone", Adresse `https://github.com/LacoticomoHD/Strabfahrt`, Ordner öffnen.
3. **F5** drücken (oder `Strg+Umschalt+B`, oder im Terminal `npm run dev`).

Beim ersten Start installiert das Skript die Pakete und lädt die Fahrpläne (rund 300 MB, je nach Leitung 3 bis 10 Minuten). Danach öffnet sich der Browser mit der App unter `http://127.0.0.1:3000`. Beenden mit `Strg+C` im Terminal.

Weitere Aufgaben unter `Strg+Umschalt+P`, "Tasks: Run Task": Daten neu bauen, Gleise und Straßen matchen (`snap:rail`), Tests, statische Variante bauen. Für die Karte mit Gleisverlauf zuerst einmal "Gleise und Straßen matchen" ausführen und dann neu starten. Bei Port-Konflikt: `PORT=3001 npm run dev` (PowerShell: `$env:PORT=3001; npm run dev`).

## Start ohne VS Code

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
npm run snap:rail              # lädt OSM-Daten (Overpass-API) und schreibt data/shapes.json
npm run snap:rail -- --refresh # lädt die OSM-Daten neu, statt data/osm-*.json zu verwenden
npm start
```

Das Skript legt Tram und Bahn auf die OSM-Gleise und Busse auf die Wege ihrer Linienrelationen (je Liniennummer). Abschnitte ohne passenden Weg bleiben Luftlinie. Bei Bussen versucht das Skript zuerst die Wege der Linienrelation mit derselben Nummer und danach das gesamte Busnetz als Rückgriff. Wie viele Abschnitte gelingen, steht am Ende der Ausgabe. Es braucht Internet und wird dort ausgeführt, wo der Server läuft oder auf deinem Rechner (dann `data/shapes.json` kopieren). Nach jedem `build:data` muss es neu laufen, sonst ignoriert der Server die Datei und gibt eine Warnung aus. Der Standort-Knopf funktioniert nur über `localhost` oder HTTPS. Das Gleis-Matching gilt auch für die statische Variante: `build:static` nimmt `data/shapes.json` mit, wenn sie zum Modell passt.

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

Fußwege (Anfahrt zur Haltestelle, Umstiege zwischen nahen Haltestellen) werden aus der Luftlinie mit Umwegfaktor 1,3 bei 1,2 m/s geschätzt, nicht über echte Wege. Echtes Wege-Routing bräuchte das Fuß- und Straßennetz von OpenStreetMap (hunderte MB) und ist nicht gebaut.

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

## Echtzeit (Live-Verspätungen)

Der Server holt Live-Daten aus dem kostenlosen GTFS-Realtime-Stream von [gtfs.de](https://gtfs.de/de/realtime/) (Lizenz CC BY-SA 4.0). Enthalten sind Verspätungen, Ausfälle und Meldungen für Baden-Württemberg, also auch KVV-Trams, -Busse, S-Bahnen, Regional- und Fernzüge. Bei einem Test am Abend hatten rund 500 Fahrten im Raum Karlsruhe Live-Werte.

- Fahrzeuge werden um ihre Verspätung verschoben, mit Zeichen rot (zu spät), hellblau (zu früh), grün (pünktlich). Positionen bleiben geschätzt, der Stream enthält keine GPS-Positionen.
- Abfahrten, Tafel und Verbindungen zeigen die Abweichung. Ausgefallene Fahrten sind durchgestrichen und werden in der Verbindungssuche gemieden.
- Gründe ("Defektes Stellwerk") stehen beim Fahrzeug. "📢 Meldungen" listet Bau- und Störungsmeldungen, Karlsruher zuerst.
- "⏱ Pünktlichkeit": Der Server schreibt mit, solange die App benutzt wird (30 Tage, `data/stats.json`), und zeigt je Linie mittlere Verspätung, Anteil ab 3 Minuten zu spät und Ausfälle.
- Zuordnung: Fern- und Regionalzüge passen direkt. Für KVV-Fahrten lädt `build:data` zusätzlich den gtfs.de-Nahverkehrsfeed (rund 270 MB, wird nicht angezeigt) und ordnet über Linie, erste Abfahrt und letzte Ankunft zu (`data/rt-map.json`, rund 86 % der Fahrten).
- Der Stream ist rund 11 MB groß. Der Server lädt ihn nur, solange jemand die App offen hat, standardmäßig jede Minute (`STRAB_RT_INTERVAL=Sekunden`), und pausiert nach 5 Minuten ohne Nutzung. Das sind rund 650 MB pro Stunde Nutzung. Abschalten mit `STRAB_RT=0`.
- **Nur mit Server.** Die statische Web-Variante (GitHub Pages) kann den Stream nicht selbst verarbeiten. Sie kann aber Live-Daten von einem eigenen, dauerhaft laufenden STRABFAHRT-Server holen: `npm run build:static -- --tiles --rt-url https://dein-server.de`, im Workflow über die Repository-Variable `STRAB_RT_URL`. Der Server muss per HTTPS erreichbar sein.

## Dauerbetrieb (Raspberry Pi oder kleiner Server)

- Docker: `docker build -t strabfahrt .` und `docker run -d -p 3000:3000 -v strabfahrt-data:/app/data --restart unless-stopped strabfahrt`.
- Ohne Docker: `deploy/strabfahrt.service` (systemd) und `deploy/update.sh` (nächtlich per cron: neu bauen, prüfen, nur bei Erfolg übernehmen, neu starten).
- Empfohlen: 2 GB RAM für den Datenbau (der Nahverkehrsfeed ist groß), der laufende Server braucht deutlich weniger.
- Für HTTPS einen Reverse-Proxy davorsetzen (z. B. Caddy) oder einen Tunnel nutzen.

## Echtzeit-Schnittstelle

Der Client fragt `GET /api/delays` alle 20 Sekunden ab, sobald `/api/meta` den Wert `"realtime": true` meldet. Antwort: `{ d: {Fahrt-ID: Sekunden}, c: [ausgefallene IDs], r: {Fahrt-ID: Grund}, updated, feedTime, error }`. Dazu `GET /api/alerts` und `GET /api/stats`. Diese drei Endpunkte erlauben Abrufe von anderen Ursprüngen (CORS).

## Mögliche nächste Schritte

- Echtzeit über die offizielle TRIAS-Schnittstelle des KVV für die Abfahrtsanzeige, sobald Zugangsdaten nach der KVV-Nutzungsvereinbarung vorliegen
- Verbindungssuche: Fußwege zu weiter entfernten Haltestellen, spätere und frühere Abfahrten blättern
- Eigene Kachelquelle
