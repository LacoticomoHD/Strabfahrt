import { getLive, send } from './_live.mjs';

export default async function handler(req, res) {
  try {
    const rt = await getLive();
    // Nach einer Pause liefert das CDN sofort den letzten Stand (bis 10 Min. alt) und holt im Hintergrund frisch
    send(res, 200, rt.snapshot(), 60, 600);
  } catch (e) {
    send(res, 200, { enabled: true, updated: 0, error: e.message, d: {}, c: [], r: {} }, 10);
  }
}
