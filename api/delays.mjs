import { getLive, send } from './_live.mjs';

export default async function handler(req, res) {
  try {
    const rt = await getLive();
    send(res, 200, rt.snapshot(), 45);
  } catch (e) {
    send(res, 200, { enabled: true, updated: 0, error: e.message, d: {}, c: [], r: {} }, 10);
  }
}
