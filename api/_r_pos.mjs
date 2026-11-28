import crypto from 'node:crypto';
import { getLive, send } from './_live.mjs';

// Mitfahrende teilen freiwillig, wo ihre Bahn gerade ist: POST /api/pos?id=<Fahrt-ID>&d=<Verspätung in s>
// Das Gerät rechnet den Standort selbst in eine Verspätung um, Koordinaten werden nicht gesendet.
// Gegen Mehrfachmeldungen merkt sich der Server eine gekürzte Prüfsumme der Adresse, höchstens 10 Minuten.
export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'nur POST' }, 0, 0);
  const q = new URL(req.url, 'http://x').searchParams;
  const id = q.get('id') || '';
  const d = Number(q.get('d'));
  if (!id || id.length > 200 || !Number.isFinite(d)) return send(res, 400, { error: 'id oder d fehlt' }, 0, 0);
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'x';
  const who = crypto.createHash('sha256').update(`strab-pos|${ip}`).digest('hex').slice(0, 12);
  try {
    const rt = await getLive();
    const r = rt.addCrowdDelay(id, d, who);
    send(res, r.ok ? 200 : 429, r, 0, 0);
  } catch (e) {
    send(res, 502, { error: String(e.message || e) }, 0, 0);
  }
}
