// Baut eine statische Variante in dist-static/ (reine Dateien, kein Server noetig).
// Alles laeuft im Browser: Fahrplanlogik, Suche, Abfahrten. Geeignet fuer GitHub Pages oder jeden Datei-Webspace.
//
//   node scripts/build-static.mjs            ohne Kartenkacheln (schematisches Liniennetz)
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

const copy = (from, to) => fs.copyFileSync(need(from), path.join(OUT, to));
copy(path.join(ROOT, 'data', 'model.json'), 'model.json');
copy(path.join(ROOT, 'server', 'model.mjs'), 'model.mjs');
for (const f of ['app.js', 'local-api.js', 'style.css']) copy(path.join(ROOT, 'public', f), f);
for (const f of ['leaflet.js', 'leaflet.css']) copy(path.join(ROOT, 'node_modules', 'leaflet', 'dist', f), path.join('vendor', 'leaflet', f));
fs.writeFileSync(path.join(OUT, 'static-flag.js'), 'window.STRAB_STATIC = true;\n');

let html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
html = html
  .replaceAll('href="/vendor/', 'href="vendor/')
  .replaceAll('src="/vendor/', 'src="vendor/')
  .replace('href="/style.css"', 'href="style.css"')
  .replace('<script src="vendor/leaflet/leaflet.js"></script>', '<script src="static-flag.js"></script>\n  <script src="vendor/leaflet/leaflet.js"></script>')
  .replace('<script src="/app.js" type="module"></script>', '<script src="app.js" type="module"></script>')
  .replace('<title>STRABFAHRT – Fahrzeuge im Raum Karlsruhe</title>', '<title>STRABFAHRT (Vorschau)</title>');
if (html.includes('"/')) throw new Error('index.html enthaelt noch absolute Pfade');
fs.writeFileSync(path.join(OUT, 'index.html'), html);

const files = fs.readdirSync(OUT, { recursive: true }).filter((f) => fs.statSync(path.join(OUT, f)).isFile());
console.log('dist-static:', files.join(', '));
