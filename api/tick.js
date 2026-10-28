import { runTick } from './_lib.js';

// An external scheduler calls this every minute: /api/tick?key=YOUR_CRON_SECRET
export default async function handler(req, res) {
  if (process.env.CRON_SECRET && req.query.key !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    const s = await runTick(10000);
    res.status(200).json({ ok: true, checked_at: s.checked_at, bleeding: Object.keys(s.bleeding) });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
}
