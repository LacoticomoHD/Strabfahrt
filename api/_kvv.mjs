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

const cached = (source, ref) => {
  const key = `${source}|${ref}`;
  let c = cache.get(key);
  if (!c || Date.now() - c.at > TTL) {
    if (!allow(source)) return c ? c.promise : Promise.resolve({ error: 'Abruflimit erreicht', events: [], source });
    c = { at: Date.now(), promise: fetchStopEvents(ref, { count: 60, source }).catch((e) => ({ error: String(e.message || e), events: [], source })) };
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
export async function kvvForStation(model, idx, deps, { only } = {}) {
  if (!triasEnabled()) return null;
  const ref = triasStopRef(model, idx);
  if (!ref) return null;
  const { dayStartUnix } = berlinNow();
  const run = async (source) => {
    const r = await cached(source, ref);
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
