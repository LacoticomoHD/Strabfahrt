// Gemeinsamer Teil der Vercel-Funktionen: haelt Modell, Zuordnung und die letzten Live-Daten im Speicher.
// Fahrplandaten kommen von der veroeffentlichten Seite (GitHub Pages), damit hier nur Code liegt.
// Die Puenktlichkeits-Statistik liegt in Vercel Blob (eine JSON-Datei), weil Funktionen keinen festen Speicher haben.

import { Model } from '../server/model.mjs';
import { Realtime, RT_ATTRIBUTION } from '../server/realtime.mjs';

const DATA_URL = (process.env.STRAB_DATA_URL || 'https://strabfahrt.de/').replace(/\/?$/, '/');
const DATA_TTL = 6 * 3600 * 1000; // Fahrplan alle 6 Stunden neu pruefen
const LIVE_TTL = 120 * 1000; // Live-Daten hoechstens alle 2 Minuten neu holen (jeder Abruf kostet CPU-Kontingent)
const STATS_PATH = 'stats/strabfahrt.json';
const STATS_SAVE_EVERY = 25 * 60 * 1000; // Blob-Schreibzugriffe sparsam halten (Hobby-Kontingent)

let data = null; // { model, realtime, loaded }
let dataPromise = null;
let livePromise = null;
let statsLoaded = null; // Promise
let lastSave = 0;

async function getJson(name) {
  const res = await fetch(DATA_URL + name, { headers: { 'User-Agent': 'STRABFAHRT-live' } });
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  return res.json();
}

// Oeffentliche Adresse der Statistik-Datei aus dem Token ableiten (vercel_blob_rw_<storeId>_<geheim>)
function statsUrl() {
  const token = process.env.BLOB_READ_WRITE_TOKEN || '';
  const id = token.split('_')[3];
  return id ? `https://${id.toLowerCase()}.public.blob.vercel-storage.com/${STATS_PATH}` : '';
}

export async function readStats() {
  const url = statsUrl();
  if (!url) return null;
  const res = await fetch(`${url}?t=${Date.now()}`, { cache: 'no-store' });
  if (res.status === 404) return { stats: {}, seen: [], savedAt: 0 };
  if (!res.ok) throw new Error(`Statistik: HTTP ${res.status}`);
  return res.json();
}

// Anonymer Zähler für App-Starts: je Tag { web, app }. Wird mit der Statistik gespeichert (keine eigenen Schreibzugriffe).
const pendingHits = {};
let savedHits = {};
const berlinDay = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(new Date()).replace(/-/g, '');
export function addHit(kind) {
  const d = berlinDay();
  pendingHits[d] = pendingHits[d] || { web: 0, app: 0 };
  pendingHits[d][kind === 'app' ? 'app' : 'web'] += 1;
}
function mergedHits(base) {
  const out = {};
  for (const [d, v] of Object.entries(base || {})) out[d] = { web: v.web || 0, app: v.app || 0 };
  for (const [d, v] of Object.entries(pendingHits)) { out[d] = out[d] || { web: 0, app: 0 }; out[d].web += v.web; out[d].app += v.app; }
  return Object.fromEntries(Object.keys(out).sort().slice(-60).map((d) => [d, out[d]]));
}
export async function hitsByDay() {
  let err = null;
  const remote = await readStats().catch((e) => { err = e.message; return null; });
  if (remote && remote.hits) savedHits = remote.hits;
  const all = mergedHits(savedHits);
  const days = Object.keys(all).sort().reverse().map((date) => ({ date, ...all[date] }));
  // Zustand der Speicherdatei (ohne Inhalt), damit ein leerer Zähler erklärbar ist
  const info = { read: err ? `Fehler: ${err}` : remote ? 'ok' : 'kein Speicher', savedAt: remote ? remote.savedAt || 0 : 0, hasHits: Boolean(remote && remote.hits) };
  return { days, info };
}

async function saveStats(rt) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return;
  if (Date.now() - lastSave < STATS_SAVE_EVERY) return;
  // Andere Instanz hat gerade gespeichert? Dann deren Stand uebernehmen und warten.
  const remote = await readStats().catch((e) => { console.warn('Statistik lesen:', e.message); return undefined; });
  // Lesen fehlgeschlagen: nicht speichern, sonst würde der gespeicherte Stand (Zähler, Statistik) überschrieben
  if (remote === undefined) return;
  if (remote && Date.now() - (remote.savedAt || 0) < STATS_SAVE_EVERY) {
    mergeRemote(rt, remote);
    lastSave = remote.savedAt;
    return;
  }
  if (remote) mergeRemote(rt, remote);
  rt.lastFlush = 0;
  rt.flushStats();
  const { put } = await import('@vercel/blob');
  const hits = mergedHits(remote ? remote.hits : savedHits);
  const body = JSON.stringify({ savedAt: Date.now(), stats: rt.stats, seen: [...rt.seen], hits });
  await put(STATS_PATH, body, { access: 'public', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json', cacheControlMaxAge: 60 });
  lastSave = Date.now();
  savedHits = hits;
  for (const k of Object.keys(pendingHits)) delete pendingHits[k];
}

// Gespeicherten Stand einmischen, ohne eigene neuere Werte zu verlieren
function mergeRemote(rt, remote) {
  for (const [k, v] of remote.seen || []) if (!rt.seen.has(k)) rt.seen.set(k, v);
  for (const [d, lines] of Object.entries(remote.stats || {})) {
    rt.stats[d] = { ...lines, ...(rt.stats[d] || {}) };
  }
}

async function loadData() {
  const [m, map] = await Promise.all([getJson('model.json'), getJson('rt-map.json').catch(() => null)]);
  const model = new Model(m);
  const realtime = new Realtime(model, null, { map: map || undefined, persist: false, collect: Boolean(process.env.BLOB_READ_WRITE_TOKEN) });
  realtime.enabled = true;
  return { model, realtime, loaded: Date.now() };
}

async function ensureData() {
  if (data && Date.now() - data.loaded < DATA_TTL) return data;
  if (!dataPromise) {
    dataPromise = loadData().then((d) => {
      // Statistik eines frueheren Modells mitnehmen
      if (data) { d.realtime.stats = data.realtime.stats; d.realtime.seen = data.realtime.seen; }
      data = d;
      return d;
    }).finally(() => { dataPromise = null; });
  }
  // Bei Neuladen alte Daten weiter nutzen, falls vorhanden
  return data && dataPromise ? data : dataPromise;
}

export async function getModel() {
  return (await ensureData()).model;
}

export async function getLive() {
  const d = await ensureData();
  const rt = d.realtime;
  if (rt.collect && !statsLoaded) statsLoaded = readStats().then((s) => { if (s) mergeRemote(rt, s); }).catch((e) => console.warn(e.message));
  if (Date.now() - rt.updated > LIVE_TTL) {
    if (!livePromise) {
      livePromise = rt.fetchOnce()
        .then(async () => { if (rt.collect) { await statsLoaded; await saveStats(rt).catch((e) => console.warn('Statistik:', e.message)); } })
        .finally(() => { livePromise = null; });
    }
    await livePromise;
  }
  return rt;
}

/** Live-Daten mit Zeitgrenze: nach einer Pause dauert der erste Abruf mehrere Sekunden, so lange soll niemand warten. */
export function getLiveSoon(ms = 1200) {
  const p = getLive().catch(() => null);
  return Promise.race([p, new Promise((r) => setTimeout(() => r(data && data.realtime.updated ? data.realtime : null), ms))]);
}

export function send(res, status, body, maxAge = 30, swr = 60) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  // CDN-Cache: alle Nutzer teilen sich einen Abruf pro Minute
  res.setHeader('Cache-Control', `public, max-age=10, s-maxage=${maxAge}, stale-while-revalidate=${swr}`);
  res.statusCode = status;
  res.end(JSON.stringify(body));
}

export { RT_ATTRIBUTION };
