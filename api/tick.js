import { runTick } from './_lib.js';
import {
  queueChaosWeeklySeasonReport,
  dispatchChaosWeeklySeasonReport,
} from './_season-alerts.js';

// An external scheduler calls this every minute: /api/tick?key=YOUR_CRON_SECRET
export default async function handler(req, res) {
  if (process.env.CRON_SECRET && req.query.key !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    const s = await runTick(10000);
    const result = {
      ok: true,
      checked_at: s.checked_at,
      bleeding: Object.keys(s.bleeding),
    };

    // The database queues at most one report per completed season/week. Delivery
    // is isolated so a Discord failure cannot interrupt the existing bleed tick.
    try {
      const queued = await queueChaosWeeklySeasonReport();
      const delivered = await dispatchChaosWeeklySeasonReport();
      if (queued.status === 'queued' ||
          ['sent', 'sent_unconfirmed', 'retry_scheduled'].includes(delivered.status)) {
        result.weekly_report = { queue: queued, delivery: delivered };
      }
    } catch (error) {
      console.error('Weekly season report processing failed:',
        String(error && error.message || error).slice(0, 400));
    }

    return res.status(200).json(result);
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
}
