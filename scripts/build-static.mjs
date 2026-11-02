// Baut eine statische Variante in dist-static/ (reine Dateien, kein Server noetig).
// Alles laeuft im Browser: Fahrplanlogik, Suche, Abfahrten. Geeignet fuer GitHub Pages oder jeden Datei-Webspace.
//
//   node scripts/build-static.mjs            ohne Kartenkacheln (schematisches Liniennetz)
//   node scripts/build-static.mjs --tiles    mit OpenStreetMap-Kacheln (fuer eigenen Webspace, GitHub Pages)
//   --rt-url https://mein-server.de          Live-Daten von einem laufenden STRABFAHRT-Server holen (muss HTTPS sein)
//                                            (auch ueber die Umgebungsvariable STRAB_RT_URL)
//
// Voraussetzung: data/model.json und node_modules/leaflet (npm install).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'dist-static');
const need = (p) => { if (!fs.existsSync(p)) throw new Error(`${p} fehlt`); return p; };

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'vendor', 'leaflet'), { recursive: true });
fs.mkdirSync(path.join(OUT, 'vendor', 'qrcode'), { recursive: true });

const copy = (from, to) => fs.copyFileSync(need(from), path.join(OUT, to));
copy(path.join(ROOT, 'data', 'model.json'), 'model.json');
// .js statt .mjs, damit auch einfache Webserver die Datei als JavaScript ausliefern
copy(path.join(ROOT, 'server', 'model.mjs'), 'model.js');
for (const f of ['app.js', 'style.css', 'insets.js']) copy(path.join(ROOT, 'public', f), f);
for (const f of ['manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png']) copy(path.join(ROOT, 'public', f), f);
// Gleisgeometrie nur mitnehmen, wenn sie zu genau diesem Modell passt
const shapesFile = path.join(ROOT, 'data', 'shapes.json');
if (fs.existsSync(shapesFile)) {
  const shapes = JSON.parse(fs.readFileSync(shapesFile, 'utf8'));
  const model = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'model.json'), 'utf8'));
  if (shapes.meta && shapes.meta.modelBuilt === model.meta.built) {
    copy(shapesFile, 'shapes.json');
    console.log(`Gleisgeometrie eingebunden (${shapes.meta.matched} Abschnitte)`);
  } else {
    console.warn('data/shapes.json passt nicht zu data/model.json und wird nicht eingebunden');
  }
}
fs.writeFileSync(path.join(OUT, 'sw.js'), fs.readFileSync(path.join(ROOT, 'public', 'sw.js'), 'utf8').replace("const VERSION = 'dev';", `const VERSION = '${Date.now()}';`));
fs.writeFileSync(path.join(OUT, 'local-api.js'), fs.readFileSync(path.join(ROOT, 'public', 'local-api.js'), 'utf8').replace("'./model.mjs'", "'./model.js'"));
for (const f of ['leaflet.js', 'leaflet.css']) copy(path.join(ROOT, 'node_modules', 'leaflet', 'dist', f), path.join('vendor', 'leaflet', f));
const tiles = process.argv.includes('--tiles');
copy(path.join(ROOT, 'node_modules', 'qrcode-generator', 'dist', 'qrcode.js'), path.join('vendor', 'qrcode', 'qrcode.js'));
const nativeApp = process.argv.includes('--native'); // fuer die Android-App: frische Daten von GitHub Pages
const dataUrl = process.env.STRAB_DATA_URL || 'https://lacoticomohd.github.io/Strabfahrt/';
const rtArg = process.argv.indexOf('--rt-url');
const rtUrl = rtArg >= 0 ? process.argv[rtArg + 1] : process.env.STRAB_RT_URL || '';
if (rtUrl && !/^(https:\/\/[^\s"']+|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?)$/.test(rtUrl)) throw new Error('--rt-url muss eine https-Adresse sein');
fs.writeFileSync(path.join(OUT, 'static-flag.js'), `window.STRAB_STATIC = true;\n${tiles ? 'window.STRAB_TILES = true;\n' : ''}${rtUrl ? `window.STRAB_RT_URL = ${JSON.stringify(rtUrl)};\n` : ''}${nativeApp ? `window.STRAB_NATIVE = true;\nwindow.STRAB_DATA_URL = ${JSON.stringify(dataUrl)};\n` : ''}`);
// Live-Adresse auch als Datei: die App liest sie beim Start, ohne neu gebaut werden zu muessen
fs.writeFileSync(path.join(OUT, 'config.json'), JSON.stringify({ rtUrl: rtUrl || '' }));
// Zuordnung fuer die Live-Funktion (Vercel), nicht fuer den Browser
const rtMapFile = path.join(ROOT, 'data', 'rt-map.json');
if (fs.existsSync(rtMapFile)) copy(rtMapFile, 'rt-map.json');
if (rtUrl) console.log('Live-Daten von', rtUrl);
if (tiles) console.log('Variante mit Kacheln: Nutzungsrichtlinie von OpenStreetMap beachten (geringe Last)');

let html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
html = html
  .replaceAll('href="/vendor/', 'href="vendor/')
  .replaceAll('src="/vendor/', 'src="vendor/')
  .replace('href="/style.css"', 'href="style.css"')
  .replace('src="/insets.js"', 'src="insets.js"')
  .replace('<script src="vendor/leaflet/leaflet.js"></script>', '<script src="static-flag.js"></script>\n  <script src="vendor/leaflet/leaflet.js"></script>')
  .replace('<script src="/app.js" type="module"></script>', '<script src="app.js" type="module"></script>')
  .replace('<title>STRABFAHRT – Fahrzeuge im Raum Karlsruhe</title>', tiles ? '<title>STRABFAHRT</title>' : '<title>STRABFAHRT (Vorschau)</title>');
if (html.includes('"/')) throw new Error('index.html enthaelt noch absolute Pfade');
fs.writeFileSync(path.join(OUT, 'index.html'), html);

const files = fs.readdirSync(OUT, { recursive: true }).filter((f) => fs.statSync(path.join(OUT, f)).isFile());
console.log('dist-static:', files.join(', '));
