// api/member-records.js
// Member-specific all-time personal bests and durable daily/weekly performance.

const { SUPABASE_URL } = process.env;
const KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY };
const REST = SUPABASE_URL + '/rest/v1';

const TITLES = {
  season_gain: 'Highest Season Gain',
  active_days: 'Most Active Days',
  longest_streak: 'Longest Active Streak',
  gain_events: 'Most Recorded Increases',
  best_day_gain: 'Best Single-Day Gain',
  best_week_gain: 'Best Calendar-Week Gain',
};

async function read(path, label) {
  const response = await fetch(REST + path, { headers: H });
  if (!response.ok) throw new Error(label + ' read failed: ' + response.status);
  return response.json();
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method not allowed' });
  }
  if (!SUPABASE_URL || !KEY) {
    return res.status(500).json({ error: 'member records are not configured' });
  }

  const name = typeof req.query.name === 'string' ? req.query.name.trim() : '';
  if (!name || name.length > 120) {
    return res.status(400).json({ error: 'a valid member name is required' });
  }

  try {
    const recordsQuery = new URLSearchParams({
      select: 'member,record_key,record_title,record_value,season_number,period_start,period_end,achieved_at,updated_at',
      member: 'eq.' + name,
      order: 'record_key.asc',
      limit: '20',
    });
    const dailyQuery = new URLSearchParams({
      select: 'season_number,activity_date,daily_gain,gain_events,first_gain_at,last_gain_at',
      member: 'eq.' + name,
      order: 'activity_date.desc,season_number.desc',
      limit: '5000',
    });
    const statsQuery = new URLSearchParams({
      select: 'season_number,starting_rep,current_rep,season_gain,gain_events,active_days,current_streak_days,longest_streak_days,last_streak_day',
      member: 'eq.' + name,
      order: 'season_number.desc',
      limit: '100',
    });
    const seasonsQuery = new URLSearchParams({
      select: 'season_number,started_at,ended_at,status',
      order: 'season_number.desc',
      limit: '100',
    });

    const [records, dailyRows, statsRows, seasons] = await Promise.all([
      read('/chaos_personal_best_records?' + recordsQuery.toString(), 'Member personal records'),
      read('/chaos_season_daily_stats?' + dailyQuery.toString(), 'Member daily history'),
      read('/chaos_season_member_stats?' + statsQuery.toString(), 'Member season totals'),
      read('/chaos_seasons?' + seasonsQuery.toString(), 'Season history'),
    ]);

    const recordByKey = Object.fromEntries((Array.isArray(records) ? records : [])
      .map(row => [row.record_key, {
        record_key: row.record_key,
        record_title: row.record_title || TITLES[row.record_key] || row.record_key,
        record_value: Number(row.record_value || 0),
        season_number: Number(row.season_number),
        period_start: row.period_start || null,
        period_end: row.period_end || null,
        achieved_at: row.achieved_at == null ? null : Number(row.achieved_at),
        date_known: row.achieved_at != null,
      }]));

    const stats = Array.isArray(statsRows) ? statsRows : [];
    const seasonList = Array.isArray(seasons) ? seasons : [];
    const activeSeason = seasonList.find(row => row.status === 'active') || null;
    const activeStats = activeSeason
      ? stats.find(row => Number(row.season_number) === Number(activeSeason.season_number)) || null
      : null;

    const days = Array.isArray(dailyRows) ? dailyRows : [];
    const weekTotals = new Map();
    for (const row of days) {
      const d = new Date(String(row.activity_date).slice(0,10) + 'T00:00:00Z');
      const weekday = d.getUTCDay() || 7;
      d.setUTCDate(d.getUTCDate() - weekday + 1);
      const start = d.toISOString().slice(0,10);
      const key = Number(row.season_number) + '|' + start;
      if (!weekTotals.has(key)) weekTotals.set(key, {
        season_number: Number(row.season_number),
        week_start: start,
        week_end: new Date(d.getTime() + 6*86400000).toISOString().slice(0,10),
        gain: 0,
        daily_rows: 0,
      });
      const week = weekTotals.get(key);
      week.gain += Number(row.daily_gain || 0);
      week.daily_rows++;
    }

    const bestWeeks = Array.from(weekTotals.values()).sort((a,b) =>
      b.gain - a.gain || b.week_start.localeCompare(a.week_start)
    ).slice(0,10);
    const activeDailyRows = activeSeason
      ? days.filter(row => Number(row.season_number) === Number(activeSeason.season_number))
      : [];
    const activeWeeks = Array.from(weekTotals.values())
      .filter(row => activeSeason && Number(row.season_number) === Number(activeSeason.season_number));
    const currentBestDay = activeDailyRows.reduce((best,row) =>
      Math.max(best,Number(row.daily_gain || 0)),0);
    const currentBestWeek = activeWeeks.reduce((best,row) =>
      Math.max(best,Number(row.gain || 0)),0);
    const recentDaily = days.slice(0,45).map(row => ({
      season_number: Number(row.season_number),
      activity_date: String(row.activity_date).slice(0,10),
      daily_gain: Number(row.daily_gain || 0),
      gain_events: Number(row.gain_events || 0),
      first_gain_at: Number(row.first_gain_at || 0),
      last_gain_at: Number(row.last_gain_at || 0),
    }));

    const seasonsWithActivity = new Set(days.map(row => Number(row.season_number))).size;
    const recordsHeld = Object.keys(recordByKey).length;
    const outputRecords = Object.values(recordByKey).sort((a,b) =>
      a.record_key.localeCompare(b.record_key)
    );

    res.setHeader('Cache-Control', 's-maxage=15, stale-while-revalidate=15');
    return res.status(200).json({
      generated_at: Date.now(),
      timezone: 'Asia/Manila',
      name,
      active_season_number: activeSeason ? Number(activeSeason.season_number) : null,
      current_season: activeSeason ? {
        season_number: Number(activeSeason.season_number),
        starting_rep: activeStats ? Number(activeStats.starting_rep || 0) : null,
        current_rep: activeStats ? Number(activeStats.current_rep || 0) : null,
        season_gain: activeStats ? Number(activeStats.season_gain || 0) : 0,
        gain_events: activeStats ? Number(activeStats.gain_events || 0) : 0,
        active_days: activeStats ? Number(activeStats.active_days || 0) : 0,
        current_streak_days: activeStats ? Number(activeStats.current_streak_days || 0) : 0,
        best_streak_days: activeStats ? Number(activeStats.longest_streak_days || 0) : 0,
        best_day_gain: currentBestDay,
        best_week_gain: currentBestWeek,
      } : null,
      records: outputRecords,
      record_count: recordsHeld,
      season_count: stats.length,
      seasons_with_daily_history: seasonsWithActivity,
      recent_daily: recentDaily,
      best_weeks: bestWeeks,
      daily_tracking: {
        available: days.length > 0,
        rows: days.length,
        first_day: days.length ? String(days[days.length - 1].activity_date).slice(0,10) : null,
        last_day: days.length ? String(days[0].activity_date).slice(0,10) : null,
        note: 'Daily and calendar-week records start with the durable daily ledger; older 30-day event data is not used to reconstruct a complete history.',
      },
    });
  } catch (error) {
    return res.status(502).json({
      error: error && error.message ? error.message : 'member records unavailable',
    });
  }
}
