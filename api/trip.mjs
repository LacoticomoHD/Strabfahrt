import { getLive, getModel, send } from './_live.mjs';
import { kvvForStation, berlinNow } from './_kvv.mjs';

// Live-Stand einer einzelnen Fahrt, für die Erinnerungen der App.
// GET /api/trip?id=<Fahrt-ID>  ->  { delay: Sekunden oder null, canceled, updated }
export default async function handler(req, res) {
  const id = new URL(req.url, 'http://x').searchParams.get('id') || '';
  if (!id || id.length > 200) return send(res, 400, { error: 'id fehlt' }, 60);
  try {
    const rt = await getLive();
    let delay = rt.delays.has(id) ? rt.delays.get(id) : null;
    let canceled = rt.canceled.has(id);
    let source = 'gtfs.de';
    // Mit Haltestelle: genauere KVV-Echtzeit bevorzugen
    const stop = new URL(req.url, 'http://x').searchParams.get('stop');
    if (stop) {
      const model = await getModel();
      let idx = model.stops.findIndex((s) => s[0] === stop);
      if (idx >= 0 && model.stops[idx][4] >= 0) idx = model.stops[idx][4];
      if (idx >= 0) {
        const { ymd, sec } = berlinNow();
        const k = await kvvForStation(model, idx, model.departures(idx, ymd, sec - 30 * 60, sec + 4 * 3600, 400)).catch(() => null);
        const v = k && k.map.get(id);
        if (v) { if (v.delay !== null) delay = v.delay; canceled = canceled || v.canceled; source = k.source; }
      }
    }
    send(res, 200, { id, delay, canceled, source, updated: rt.updated }, 30);
  } catch (e) {
    send(res, 502, { error: String(e.message || e) }, 15);
  }
}
