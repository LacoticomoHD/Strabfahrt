// Gemeinsamer Teil der Vercel-Funktionen: haelt Modell, Zuordnung und die letzten Live-Daten im Speicher.
// Fahrplandaten kommen von der veroeffentlichten Seite (GitHub Pages), damit hier nur Code liegt.

import { Model } from '../server/model.mjs';
import { Realtime, RT_ATTRIBUTION } from '../server/realtime.mjs';

const DATA_URL = (process.env.STRAB_DATA_URL || 'https://lacoticomohd.github.io/Strabfahrt/').replace(/\/?$/, '/');
const DATA_TTL = 6 * 3600 * 1000; // Fahrplan alle 6 Stunden neu pruefen
const LIVE_TTL = 50 * 1000; // Live-Daten hoechstens alle 50 Sekunden neu holen

let data = null; // { model, realtime, loaded }
let dataPromise = null;
let livePromise = null;

async function getJson(name) {
  const res = await fetch(DATA_URL + name, { headers: { 'User-Agent': 'STRABFAHRT-live' } });
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  return res.json();
}

async function loadData() {
  const [m, map] = await Promise.all([getJson('model.json'), getJson('rt-map.json').catch(() => null)]);
  const model = new Model(m);
  const realtime = new Realtime(model, null, { map: map || undefined, persist: false });
  realtime.enabled = true;
  return { model, realtime, loaded: Date.now() };
}

async function ensureData() {
  if (data && Date.now() - data.loaded < DATA_TTL) return data;
  if (!dataPromise) {
    dataPromise = loadData().then((d) => { data = d; return d; }).finally(() => { dataPromise = null; });
  }
  // Bei Neuladen alte Daten weiter nutzen, falls vorhanden
  return data && dataPromise ? data : dataPromise;
}

export async function getLive() {
  const d = await ensureData();
  if (Date.now() - d.realtime.updated > LIVE_TTL) {
    if (!livePromise) livePromise = d.realtime.fetchOnce().finally(() => { livePromise = null; });
    await livePromise;
  }
  return d.realtime;
}

export function send(res, status, body, maxAge = 30) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  // CDN-Cache: alle Nutzer teilen sich einen Abruf pro Minute
  res.setHeader('Cache-Control', `public, max-age=10, s-maxage=${maxAge}, stale-while-revalidate=60`);
  res.statusCode = status;
  res.end(JSON.stringify(body));
}

export { RT_ATTRIBUTION };
