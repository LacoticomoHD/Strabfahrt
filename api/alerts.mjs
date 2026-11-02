import { getLive, send } from './_live.mjs';

export default async function handler(req, res) {
  try {
    const rt = await getLive();
    send(res, 200, { updated: rt.updated, alerts: rt.alerts }, 120);
  } catch (e) {
    send(res, 200, { updated: 0, alerts: [], error: e.message }, 10);
  }
}
