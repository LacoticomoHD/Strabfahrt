// KVV-Echtzeit (TRIAS) je Station, kurz zwischengespeichert. Ohne KVV_TRIAS_REF bleibt alles aus.
import { berlinOffset } from '../server/model.mjs';
import { triasEnabled, fetchStopEvents, matchEvents, triasStopRef } from '../server/trias.mjs';

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

/** Map trip -> { delay, canceled, bay } für die Abfahrten einer Station, oder null. */
export async function kvvForStation(model, idx, deps) {
  if (!triasEnabled()) return null;
  const ref = triasStopRef(model, idx);
  if (!ref) return null;
  let c = cache.get(ref);
  if (!c || Date.now() - c.at > TTL) {
    c = { at: Date.now(), promise: fetchStopEvents(ref, { count: 60 }).catch((e) => ({ error: String(e.message || e), events: [] })) };
    cache.set(ref, c);
    if (cache.size > 500) cache.delete(cache.keys().next().value);
  }
  const r = await c.promise;
  const { dayStartUnix } = berlinNow();
  return { error: r.error, events: r.events.length, map: matchEvents(deps, r.events, dayStartUnix) };
}
