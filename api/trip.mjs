import { getLive, send } from './_live.mjs';

// Live-Stand einer einzelnen Fahrt, für die Erinnerungen der App.
// GET /api/trip?id=<Fahrt-ID>  ->  { delay: Sekunden oder null, canceled, updated }
export default async function handler(req, res) {
  const id = new URL(req.url, 'http://x').searchParams.get('id') || '';
  if (!id || id.length > 200) return send(res, 400, { error: 'id fehlt' }, 60);
  try {
    const rt = await getLive();
    send(res, 200, { id, delay: rt.delays.has(id) ? rt.delays.get(id) : null, canceled: rt.canceled.has(id), updated: rt.updated }, 30);
  } catch (e) {
    send(res, 502, { error: String(e.message || e) }, 15);
  }
}
