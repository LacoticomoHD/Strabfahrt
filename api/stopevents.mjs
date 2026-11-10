import { getModel, send } from './_live.mjs';
import { kvvForStation, berlinNow, triasEnabled } from './_kvv.mjs';
import { normLine } from '../server/trias.mjs';

// KVV-Echtzeit für eine Station, auf die Fahrten des Modells abgebildet.
// GET /api/stopevents?stop=<Haltestellen-ID>  ->  { source, updated, d: {trip: Sekunden}, c: [trip], bay: {trip: Steig} }
let idIndex = null;
let idModel = null;

export default async function handler(req, res) {
  if (!triasEnabled()) return send(res, 200, { source: null, disabled: true }, 300);
  const stopId = new URL(req.url, 'http://x').searchParams.get('stop') || '';
  try {
    const model = await getModel();
    if (idModel !== model) { idIndex = new Map(model.stops.map((s, i) => [s[0], i])); idModel = model; }
    let idx = idIndex.get(stopId);
    if (idx === undefined) return send(res, 404, { error: 'Haltestelle unbekannt' }, 60);
    if (model.stops[idx][4] >= 0) idx = model.stops[idx][4];
    const { ymd, sec } = berlinNow();
    const deps = model.departures(idx, ymd, sec - 20 * 60, sec + 3 * 3600, 400);
    const q = new URL(req.url, 'http://x').searchParams;
    const only = ['kvv', 'mobidata'].includes(q.get('src')) ? q.get('src') : undefined;
    const k = await kvvForStation(model, idx, deps, { only });
    const d = {}; const c = []; const bay = {}; const u = {};
    if (k) for (const [trip, v] of k.map) { if (v.delay !== null) d[trip] = v.delay; if (v.canceled) c.push(trip); if (v.bay) bay[trip] = v.bay; if (v.units > 1) u[trip] = v.units; }
    if (q.get('debug') === '1' && k) {
      const fmt = (u) => new Date(u * 1000).toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin' });
      const hit = new Set([...k.map.keys()].map((t) => { const x = deps.find((y) => y.trip === t); return `${normLine(x.line)}@${k.dayStartUnix + x.t}`; }));
      const unmatched = k.list.filter((e) => !hit.has(`${normLine(e.line)}@${e.planned}`)).map((e) => ({
        line: e.line, dest: e.dest, planned: fmt(e.planned), rt: e.estimated !== null,
        near: deps.filter((d) => Math.abs(k.dayStartUnix + d.t - e.planned) < 300).slice(0, 4).map((d) => `${d.line}@${fmt(k.dayStartUnix + d.t)}`),
      }));
      return send(res, 200, { source: k.source, status: k.status, url: k.url, error: k.error, events: k.events, mapped: k.map.size, withRt: k.list.filter((e) => e.estimated !== null).length, unmatched, units: u, tags: k.tags,
        list: q.get('list') === '1' ? k.list.map((e) => ({ line: e.line, ref: e.ref, origin: e.origin, dest: e.dest, planned: fmt(e.planned), rt: e.estimated !== null, bay: e.bay, journey: e.journey })) : undefined }, 25);
    }
    send(res, 200, { source: k ? k.source : null, updated: Date.now(), events: k ? k.events : 0, matched: Object.keys(d).length, error: k ? k.error : null, d, c, bay, u }, 25);
  } catch (e) {
    send(res, 502, { error: String(e.message || e) }, 15);
  }
}
