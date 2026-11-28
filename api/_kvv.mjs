// TRIAS-Echtzeit je Station (KVV, sonst MobiData BW), kurz zwischengespeichert. Ohne Zugangsdaten bleibt alles aus.
import { berlinOffset } from '../server/model.mjs';
import { triasEnabled, enabledSources, fetchStopEvents, matchEvents, triasStopRef } from '../server/trias.mjs';

const TTL = 25 * 1000;
const cache = new Map(); // stopRef -> { at, promise }

const berlinParts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });

export function berlinNow() {
  const p = Object.fromEntries(berlinParts.formatToParts(new Date()).map((x) => [x.type, x.value]));
  const ymd = `${p.year}${p.month}${p.day}`;
  const sec = Number(p.hour) * 3600 + Number(p.minute) * 60 + Number(p.second);
  const noon = Date.UTC(+p.year, +p.month - 1, +p.day, 12);
  const dayStartUnix = Date.UTC(+p.year, +p.month - 1, +p.day) / 1000 - berlinOffset(noon) * 60;
  return { ymd, sec, dayStartUnix };
}

export { triasEnabled };

// Schutz der Schnittstellen: je Quelle höchstens so viele Abrufe pro Minute und Instanz.
// Darüber gibt es keine TRIAS-Daten, die App fällt dann auf gtfs.de zurück.
const MAX_PER_MIN = Number(process.env.TRIAS_MAX_PER_MIN) || 90;
const budget = new Map(); // source -> { start, n }
const allow = (source) => {
  const now = Date.now();
  let b = budget.get(source);
  if (!b || now - b.start > 60000) { b = { start: now, n: 0 }; budget.set(source, b); }
  return ++b.n <= MAX_PER_MIN;
};

// when: Unix-Sekunden für vergangene Abfahrten (Tagesverlauf), sonst jetzt. Vergangenes ändert sich kaum: länger zwischenspeichern.
const cached = (source, ref, when = null) => {
  const key = `${source}|${ref}|${when || ''}`;
  let c = cache.get(key);
  if (!c || Date.now() - c.at > (when ? 5 * 60 * 1000 : TTL)) {
    if (!allow(source)) return c ? c.promise : Promise.resolve({ error: 'Abruflimit erreicht', events: [], source });
    c = { at: Date.now(), promise: fetchStopEvents(ref, { count: when ? 100 : 60, source, when }).catch((e) => ({ error: String(e.message || e), events: [], source })) };
    cache.set(key, c);
    if (cache.size > 800) cache.delete(cache.keys().next().value);
  }
  return c.promise;
};

// Regional- und Fernzüge der Bahn: hier liefert MobiData BW (EFA-BW mit DB-Prognosen) die bessere Echtzeit
const RAIL = /^(RE|RB|IRE|MEX|IC|ICE|EC|ECE|EN|NJ|RJ|RJX|TGV|FLX|FEX|ECM)\s*\d*[a-z]?$/i;
export const isMainlineRail = (d) => d.type === 100 || RAIL.test(String(d.line || '').trim());

/**
 * Echtzeit für die Abfahrten einer Station: Map trip -> { delay, canceled, bay }, oder null.
 * KVV ist Hauptquelle. MobiData BW gewinnt bei Regional-/Fernzügen und füllt sonst nur Lücken.
 * only: genau eine Quelle verwenden (Fehlersuche).
 */
// Gekoppelte Fahrzeuge (Doppel-/Dreifachtraktion) aus allen KVV-Abfragen: Fahrt -> { n, at }.
// Daraus bekommt die Karte die Zahl der Fahrzeuge, ohne zusätzliche Anfragen beim KVV.
export const unitsSeen = new Map();
// Verspätungen aus allen KVV-Abfragen (genauer als gtfs.de): Fahrt -> { d, at }. Gehen an die Karte aller Nutzer.
export const kvvSeen = new Map();

export async function kvvForStation(model, idx, deps, opts = {}) {
  const res = await kvvForStationRaw(model, idx, deps, opts);
  if (res && res.map && !opts.when) {
    const now = Date.now();
    for (const [trip, v] of res.map) {
      if (v.units >= 1) unitsSeen.set(trip, { n: v.units, at: now });
      if (v.delay !== null && v.delay !== undefined) kvvSeen.set(trip, { d: v.delay, at: now });
    }
    if (kvvSeen.size > 20000) for (const [k, v] of kvvSeen) if (now - v.at > 3600 * 1000) kvvSeen.delete(k);
    if (unitsSeen.size > 20000) for (const [k, v] of unitsSeen) if (now - v.at > 6 * 3600 * 1000) unitsSeen.delete(k);
  }
  return res;
}

async function kvvForStationRaw(model, idx, deps, { only, when = null } = {}) {
  if (!triasEnabled()) return null;
  const ref = triasStopRef(model, idx);
  if (!ref) return null;
  const { dayStartUnix } = berlinNow();
  const run = async (source) => {
    const r = await cached(source, ref, when);
    return { source, error: r.error, events: r.events.length, list: r.events, map: matchEvents(deps, r.events, dayStartUnix), raw: r.raw, tags: r.tags, status: r.status, url: r.url, dayStartUnix };
  };
  const have = enabledSources();
  if (only) return have.includes(only) ? run(only) : null;
  const hasRail = deps.some(isMainlineRail);
  // Mit Zügen im Fahrplan werden beide Quellen gebraucht: gleichzeitig abrufen, das halbiert die Wartezeit
  const mdEarly = hasRail && have.includes('mobidata') ? run('mobidata') : null;
  const kvv = have.includes('kvv') ? await run('kvv') : null;
  const needMd = have.includes('mobidata') && (!kvv || kvv.error || !kvv.map.size || hasRail);
  if (!needMd) return kvv;
  const md = await (mdEarly || run('mobidata'));
  if (!kvv || kvv.error || !kvv.map.size) return md.map.size || !kvv ? md : kvv;
  // Zusammenführen
  const byTrip = new Map(deps.map((d) => [d.trip, d]));
  const map = new Map(kvv.map);
  let used = 0;
  for (const [trip, v] of md.map) {
    const d = byTrip.get(trip);
    const cur = map.get(trip);
    if ((d && isMainlineRail(d) && v.delay !== null) || !cur || (cur.delay === null && v.delay !== null)) {
      map.set(trip, { ...v, bay: v.bay || (cur && cur.bay) || '', units: Math.max(v.units || 1, (cur && cur.units) || 1) });
      used++;
    }
  }
  return { ...kvv, map, source: used ? 'kvv+mobidata' : 'kvv' };
}

// Knotenpunkte regelmäßig beim KVV abfragen, damit möglichst viele Bahnen KVV-Verspätungen haben, nicht nur die
// an gerade geöffneten Haltestellen. Läuft nur, solange jemand die Karte offen hat (angestoßen von /api/delays),
// je Knoten höchstens einmal pro Minute. Die Ergebnisse landen über kvvSeen bei allen auf der Karte.
const HUB_COUNT = Number(process.env.KVV_HUBS) || 18;
let hubs = null; // { model, list: [Stationsindex] }
const hubAt = new Map(); // Stationsindex -> letzter Abruf (ms)

function pickHubs(model) {
  if (hubs && hubs.model === model) return hubs.list;
  const count = new Map();
  for (const [sIdx, pats] of model.stopPatterns) {
    const st = model.stops[sIdx][4] >= 0 ? model.stops[sIdx][4] : sIdx;
    for (const [pid] of pats) {
      const type = model.routes[model.patterns[pid].route][1];
      if (type !== 0 && type !== 2) continue; // Tram und S-Bahn
      count.set(st, (count.get(st) || 0) + model.patternTrips[pid].length);
    }
  }
  const list = [...count].sort((a, b) => b[1] - a[1]).slice(0, HUB_COUNT).map(([i]) => i);
  hubs = { model, list };
  return list;
}

export async function sweepHubs(model, max = 5) {
  if (!triasEnabled()) return 0;
  const now = Date.now();
  const due = pickHubs(model).filter((i) => now - (hubAt.get(i) || 0) > 60 * 1000).slice(0, max);
  if (!due.length) return 0;
  const { ymd, sec } = berlinNow();
  for (const i of due) hubAt.set(i, now);
  await Promise.all(due.map((i) => kvvForStation(model, i, model.departures(i, ymd, sec - 30 * 60, sec + 3 * 3600, 400)).catch(() => null)));
  return due.length;
}

export function hubNames(model) {
  return pickHubs(model).map((i) => model.stops[i][1]);
}
