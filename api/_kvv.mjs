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

const cached = (source, ref) => {
  const key = `${source}|${ref}`;
  let c = cache.get(key);
  if (!c || Date.now() - c.at > TTL) {
    c = { at: Date.now(), promise: fetchStopEvents(ref, { count: 60, source }).catch((e) => ({ error: String(e.message || e), events: [], source })) };
    cache.set(key, c);
    if (cache.size > 800) cache.delete(cache.keys().next().value);
  }
  return c.promise;
};

/**
 * Echtzeit für die Abfahrten einer Station: Map trip -> { delay, canceled, bay }, oder null.
 * Reihenfolge: KVV, bei Fehler oder ohne Treffer MobiData BW. only: eine Quelle erzwingen.
 */
export async function kvvForStation(model, idx, deps, { only } = {}) {
  if (!triasEnabled()) return null;
  const ref = triasStopRef(model, idx);
  if (!ref) return null;
  const { dayStartUnix } = berlinNow();
  const order = only ? [only] : enabledSources();
  let out = null;
  for (const source of order) {
    const r = await cached(source, ref);
    const map = matchEvents(deps, r.events, dayStartUnix);
    out = { source, error: r.error, events: r.events.length, list: r.events, map, raw: r.raw, status: r.status, url: r.url, dayStartUnix };
    if (!r.error && map.size) break;
  }
  return out;
}
