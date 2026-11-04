import { getModel, send } from './_live.mjs';
import { kvvForStation, berlinNow, triasEnabled } from './_kvv.mjs';

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
    const k = await kvvForStation(model, idx, deps);
    const d = {}; const c = []; const bay = {};
    if (k) for (const [trip, v] of k.map) { if (v.delay !== null) d[trip] = v.delay; if (v.canceled) c.push(trip); if (v.bay) bay[trip] = v.bay; }
    send(res, 200, { source: 'kvv', updated: Date.now(), events: k ? k.events : 0, matched: Object.keys(d).length, error: k ? k.error : null, d, c, bay }, 25);
  } catch (e) {
    send(res, 502, { error: String(e.message || e) }, 15);
  }
}
