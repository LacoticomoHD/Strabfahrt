import { hitsByDay, send } from './_live.mjs';

// App-Starts je Tag (anonym gezählt), neueste zuerst
export default async function handler(req, res) {
  try {
    const { days, info } = await hitsByDay();
    send(res, 200, { days, info }, 300);
  } catch (e) {
    send(res, 200, { days: [], error: String(e.message || e) }, 30);
  }
}
