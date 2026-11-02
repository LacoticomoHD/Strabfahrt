// Prueft das gebaute Modell, bevor es veroeffentlicht wird. Bricht mit Fehlercode ab, wenn etwas nicht stimmt.
//   node scripts/check-data.mjs   (npm run check:data)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Model } from '../server/model.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = process.env.STRAB_DATA_DIR ? path.resolve(process.env.STRAB_DATA_DIR) : path.join(ROOT, 'data');
const problems = [];
const check = (ok, msg) => { if (!ok) problems.push(msg); };

const model = new Model(JSON.parse(fs.readFileSync(path.join(DATA, 'model.json'), 'utf8')));
const feeds = Object.fromEntries((model.meta.feeds || []).map((f) => [f.id, f]));
check((feeds.kvv?.trips || 0) >= Number(process.env.STRAB_MIN_TRIPS || 20000), `zu wenige KVV-Fahrten: ${feeds.kvv?.trips}`);
check(model.stops.length >= 1000, `zu wenige Haltestellen: ${model.stops.length}`);
for (const id of ['fv', 'rv']) if (feeds[id]) check(feeds[id].trips > 50, `Feed ${id} fast leer: ${feeds[id].trips} Fahrten`);

// Heute muss etwas fahren, und eine Standardverbindung muss gefunden werden
const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(new Date()).replaceAll('-', '');
const busy = model.vehicles(ymd, 8 * 3600, 9 * 3600, null, null).trips.length;
check(busy > 100, `am ${ymd} zwischen 8 und 9 Uhr nur ${busy} Fahrten`);
const hbf = model.search('Karlsruhe Hauptbahnhof')[0];
const dur = model.search('Durlach Bahnhof')[0];
check(hbf && dur, 'Hauptbahnhof oder Durlach nicht gefunden');
if (hbf && dur) check(model.plan(hbf.index, dur.index, ymd, 8 * 3600).length > 0, 'keine Verbindung Hauptbahnhof nach Durlach um 8 Uhr');

// Echtzeit-Zuordnung (optional, nur Warnung)
const rtFile = path.join(DATA, 'rt-map.json');
if (fs.existsSync(rtFile)) {
  const n = Object.keys(JSON.parse(fs.readFileSync(rtFile, 'utf8')).trips || {}).length;
  if (n < 1000) console.warn(`Warnung: nur ${n} Fahrten fuer die Echtzeit zugeordnet`);
}

if (problems.length) {
  console.error('Datenpruefung fehlgeschlagen:\n- ' + problems.join('\n- '));
  process.exit(1);
}
console.log(`Datenpruefung ok: ${model.trips.length} Fahrten, ${busy} zwischen 8 und 9 Uhr am ${ymd}`);
