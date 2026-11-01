import { runTick } from './_lib.js';
import {
  queueChaosWeeklySeasonReport,
  dispatchChaosWeeklySeasonReport,
  queueChaosAwardRaceAlert,
  dispatchChaosAwardRaceAlert,
  queueChaosMemberRetentionAlerts,
  dispatchChaosMemberRetentionAlerts,
  queueChaosClanHealthAlerts,
  dispatchChaosClanHealthAlerts,
} from './_season-alerts.js';

// An external scheduler calls this every minute: /api/tick?key=YOUR_CRON_SECRET
export default async function handler(req, res) {
  if (process.env.CRON_SECRET && req.query.key !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    // Run the existing clan poll and the weekly Discord job concurrently so
    // delivery latency does not extend the bleed-check critical path.
    const [s, weeklyReport, awardRace, retention, clanHealth] = await Promise.all([
      runTick(10000),
      (async () => {
        try {
          const queued = await queueChaosWeeklySeasonReport();
          const delivered = await dispatchChaosWeeklySeasonReport();
          if (queued.status === 'queued' ||
              ['sent', 'sent_unconfirmed', 'retry_scheduled'].includes(delivered.status)) {
            return { queue: queued, delivery: delivered };
          }
          return null;
        } catch (error) {
          console.error('Weekly season report processing failed:',
            String(error && error.message || error).slice(0, 400));
          return null;
        }
      })(),
      (async () => {
        try {
          const queued = await queueChaosAwardRaceAlert();
          const delivered = await dispatchChaosAwardRaceAlert();
          if (queued.status === 'queued' ||
              ['sent', 'sent_unconfirmed', 'retry_scheduled'].includes(delivered.status)) {
            return { queue: queued, delivery: delivered };
          }
          return null;
        } catch (error) {
          console.error('Season award race processing failed:',
            String(error && error.message || error).slice(0, 400));
          return null;
        }
      })(),
      (async () => {
        try {
          const queued = await queueChaosMemberRetentionAlerts();
          const delivered = await dispatchChaosMemberRetentionAlerts();
          if (queued.status === 'queued' || ['sent', 'sent_unconfirmed', 'retry_scheduled'].includes(delivered.status)) {
            return { queue: queued, delivery: delivered };
          }
          return null;
        } catch (error) {
          console.error('Member retention alert processing failed:', String(error && error.message || error).slice(0, 400));
          return null;
        }
      })(),
  
      (async () => {
        try {
          const queued = await queueChaosClanHealthAlerts();
          const delivered = await dispatchChaosClanHealthAlerts();
          if (queued.status === 'queued' ||
              ['sent', 'sent_unconfirmed', 'retry_scheduled'].includes(delivered.status)) {
            return { queue: queued, delivery: delivered };
          }
          return null;
        } catch (error) {
          console.error('Clan Health alert processing failed:',
            String(error && error.message || error).slice(0, 400));
          return null;
        }
      })(),
  ]);
    const result = {
      ok: true,
      checked_at: s.checked_at,
      bleeding: Object.keys(s.bleeding),
    };
    if (weeklyReport) result.weekly_report = weeklyReport;
    if (awardRace) result.award_race = awardRace;
    if (retention) result.member_retention = retention;
    if (clanHealth) result.clan_health = clanHealth;
    return res.status(200).json(result);
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
}
