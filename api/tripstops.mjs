import { getLive, send } from './_live.mjs';

// Ist-Zeiten je Halt für eine Fahrt (aus gtfs.de), für den Verlauf im Fahrzeug-Fenster.
// GET /api/tripstops?id=<Fahrt-ID>  ->  { id, feedTime, s: [Plan-Ankunft, Abweichung, Plan-Abfahrt, Abweichung, ...] }
export default async function handler(req, res) {
  const id = new URL(req.url, 'http://x').searchParams.get('id') || '';
  if (!id || id.length > 200) return send(res, 400, { error: 'id fehlt' }, 60);
  try {
    const rt = await getLive();
    send(res, 200, { id, feedTime: rt.feedTime, s: rt.stopTimes.get(id) || [] }, 45);
  } catch (e) {
    send(res, 502, { error: String(e.message || e), s: [] }, 15);
  }
}
