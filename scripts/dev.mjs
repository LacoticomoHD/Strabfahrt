// Ein Befehl zum Loslegen: richtet alles ein, was fehlt, startet den Server und oeffnet den Browser.
//
//   npm run dev                  (oder in VS Code: F5 bzw. Strg+Umschalt+B)
//   npm run dev -- --no-open     ohne Browser
//   npm run dev -- --raw ordner  bereits entpackter KVV-Feed statt Download (auch --zip datei.zip)
//
// Schritte: 1) Node-Version pruefen  2) Pakete installieren, falls fehlend
//           3) KVV-Daten bauen, falls fehlend  4) Server starten  5) Browser oeffnen

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';
const args = process.argv.slice(2);
const noOpen = args.includes('--no-open');
const PORT = Number(process.env.PORT || 3000);

const major = Number(process.versions.node.split('.')[0]);
if (major < 20) {
  console.error(`Node.js ${process.versions.node} ist zu alt. Bitte Node.js 20 oder neuer installieren: https://nodejs.org`);
  process.exit(1);
}

function run(cmd, cmdArgs, label) {
  console.log(`\n> ${label}`);
  const r = spawnSync(cmd, cmdArgs, { cwd: ROOT, stdio: 'inherit', shell: isWin && cmd === 'npm' });
  if (r.status !== 0) {
    console.error(`\nSchritt fehlgeschlagen: ${label}`);
    process.exit(r.status || 1);
  }
}

if (!fs.existsSync(path.join(ROOT, 'node_modules', 'leaflet'))) {
  run('npm', ['install', '--no-audit', '--no-fund'], 'Pakete installieren (einmalig)');
}

if (!fs.existsSync(path.join(ROOT, 'data', 'model.json'))) {
  const pass = [];
  for (const flag of ['--raw', '--zip']) {
    const i = args.indexOf(flag);
    if (i >= 0 && args[i + 1]) pass.push(flag, args[i + 1]);
  }
  run(process.execPath, ['--max-old-space-size=4096', path.join('scripts', 'build-data.mjs'), ...pass], 'Fahrplandaten laden und aufbereiten (einmalig, je nach Leitung 3 bis 10 Minuten, rund 300 MB Download)');
}

process.env.PORT = String(PORT);
process.env.HOST = process.env.HOST || '127.0.0.1';
await import('../server/index.mjs');

// Warten, bis der Server antwortet, dann Browser oeffnen
const url = `http://127.0.0.1:${PORT}/`;
for (let i = 0; i < 40; i++) {
  try {
    const res = await fetch(`${url}api/meta`);
    if (res.ok) break;
  } catch { /* noch nicht bereit */ }
  await new Promise((r) => setTimeout(r, 250));
}
console.log(`\nSTRABFAHRT bereit: ${url}  (beenden mit Strg+C)`);
if (!noOpen) {
  try {
    const opener = isWin ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    spawn(opener[0], opener[1], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
  } catch { /* Browser muss von Hand geoeffnet werden */ }
}
