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
    // live=1: das gerade verfolgte Fahrzeug direkt beim KVV nachfragen, am nächsten Halt der Fahrt.
    // Die Antwort enthält alle Fahrten dieser Station, sie gehen über kvvSeen auch an die Karte der anderen.
    let at = null;
    if (!stop && new URL(req.url, 'http://x').searchParams.get('live')) {
      const model = await getModel();
      const next = nextStation(model, rt, id, delay || 0);
      if (next) {
        const { ymd, sec } = berlinNow();
        const k = await kvvForStation(model, next.station, model.departures(next.station, ymd, sec - 30 * 60, sec + 4 * 3600, 400)).catch(() => null);
        const v = k && k.map.get(id);
        if (v) { if (v.delay !== null) delay = v.delay; canceled = canceled || v.canceled; source = k.source; at = model.stops[next.station][1]; }
      }
    }
    send(res, 200, { id, delay, canceled, source, at, updated: rt.updated }, 30);
  } catch (e) {
    send(res, 502, { error: String(e.message || e) }, 15);
  }
}

// Nächster Halt der Fahrt nach Plan plus Verspätung -> { station, k }; berücksichtigt Fahrten über Mitternacht
function nextStation(model, rt, id, delay) {
  const ti = rt.tripIndex.get(id);
  if (ti === undefined) return null;
  const trip = model.trips[ti];
  const prof = model.profiles[trip.profile];
  const stops = model.patterns[trip.pattern].stops;
  const { dayStartUnix } = berlinNow();
  const now = Date.now() / 1000;
  for (const day of [dayStartUnix, dayStartUnix - 86400]) {
    const base = day + trip.start;
    if (base + prof[2 * stops.length - 1] + delay < now - 60 || base - 900 > now) continue;
    for (let k = 0; k < stops.length; k++) {
      if (base + prof[2 * k] + delay > now - 30) {
        const si = stops[k];
        const st = model.stops[si][4] >= 0 ? model.stops[si][4] : si;
        return { station: st, k };
      }
    }
  }
  return null;
}
