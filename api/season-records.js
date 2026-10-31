// api/season-records.js
// All-time season and daily personal records. Daily and weekly history begins
// when the durable daily ledger was enabled; older rolling events are not backfilled.

const { SUPABASE_URL } = process.env;
const KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY };
const REST = SUPABASE_URL + '/rest/v1';

const CATEGORIES = [
  { key: 'season_gain', title: 'Highest Season Gain', unit: 'rep', description: 'Most reputation gained in one tracked season' },
  { key: 'active_days', title: 'Most Active Days', unit: 'days', description: 'Most distinct Manila calendar days with recorded gains in one season' },
  { key: 'longest_streak', title: 'Longest Active Streak', unit: 'days', description: 'Most consecutive active days in one season' },
  { key: 'gain_events', title: 'Most Recorded Increases', unit: 'increases', description: 'Most positive changes detected between shared game reads in one season' },
  { key: 'best_day_gain', title: 'Best Single-Day Gain', unit: 'rep', description: 'Most reputation gained in one Manila calendar day' },
  { key: 'best_week_gain', title: 'Best Calendar-Week Gain', unit: 'rep', description: 'Most reputation gained Monday–Sunday within one season' },
];

async function read(path, label) {
  const response = await fetch(REST + path, { headers: H });
  if (!response.ok) throw new Error(label + ' read failed: ' + response.status);
  return response.json();
}

function formatDate(value) {
  if (!value) return null;
  return String(value).slice(0, 10);
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method not allowed' });
  }
  if (!SUPABASE_URL || !KEY) {
    return res.status(500).json({ error: 'season records are not configured' });
  }

  try {
    const recordsQuery = new URLSearchParams({
      select: 'member,record_key,record_title,record_value,season_number,period_start,period_end,achieved_at,updated_at',
      order: 'record_key.asc,record_value.desc,member.asc',
      limit: '10000',
    });
    const seasonsQuery = new URLSearchParams({
      select: 'season_number,started_at,ended_at,status',
      order: 'season_number.desc',
      limit: '100',
    });
    const dailyQuery = new URLSearchParams({
      select: 'season_number,member,activity_date,daily_gain,gain_events,first_gain_at,last_gain_at',
      order: 'activity_date.desc,daily_gain.desc,member.asc',
      limit: '20000',
    });

    const [recordsRows, seasons, dailyRows] = await Promise.all([
      read('/chaos_personal_best_records?' + recordsQuery.toString(), 'Personal records'),
      read('/chaos_seasons?' + seasonsQuery.toString(), 'Season history'),
      read('/chaos_season_daily_stats?' + dailyQuery.toString(), 'Daily season records'),
    ]);

    const recordRows = Array.isArray(recordsRows) ? recordsRows : [];
    const days = Array.isArray(dailyRows) ? dailyRows : [];
    const active = (Array.isArray(seasons) ? seasons : []).find(row => row.status === 'active') || null;
    const seasonByNumber = new Map((Array.isArray(seasons) ? seasons : [])
      .map(row => [Number(row.season_number), row]));
    const records = CATEGORIES.map(category => {
      const rows = recordRows.filter(row => row.record_key === category.key)
        .sort((a,b) => Number(b.record_value) - Number(a.record_value) ||
          String(a.member).localeCompare(String(b.member)));
      return {
        ...category,
        holder_count: rows.length,
        leaders: rows.slice(0, 15).map(row => {
          const season = seasonByNumber.get(Number(row.season_number)) || null;
          return {
            member: row.member,
            record_value: Number(row.record_value || 0),
            season_number: Number(row.season_number),
            period_start: formatDate(row.period_start),
            period_end: formatDate(row.period_end),
            achieved_at: row.achieved_at == null ? null : Number(row.achieved_at),
            tracked_from_legacy_season_totals: row.achieved_at == null &&
              (category.key === 'season_gain' || category.key === 'active_days' ||
               category.key === 'longest_streak' || category.key === 'gain_events'),
            season_status: season ? season.status : 'unknown',
          };
        }),
      };
    });

    const decorated = new Map();
    for (const row of recordRows) {
      if (!decorated.has(row.member)) {
        decorated.set(row.member, { member: row.member, records_held: 0, categories: [] });
      }
      const entry = decorated.get(row.member);
      entry.records_held++;
      entry.categories.push(row.record_key);
    }
    const mostDecorated = Array.from(decorated.values()).sort((a,b) =>
      b.records_held - a.records_held || a.member.localeCompare(b.member)
    ).slice(0, 50);

    const trackedDates = Array.from(new Set(days.map(row => formatDate(row.activity_date)))).sort();
    const recentDays = days.slice(0, 30).map(row => ({
      season_number: Number(row.season_number),
      member: row.member,
      activity_date: formatDate(row.activity_date),
      daily_gain: Number(row.daily_gain || 0),
      gain_events: Number(row.gain_events || 0),
      first_gain_at: Number(row.first_gain_at || 0),
      last_gain_at: Number(row.last_gain_at || 0),
    }));

    const seasonCoverage = (Array.isArray(seasons) ? seasons : []).map(season => {
      const rows = days.filter(row => Number(row.season_number) === Number(season.season_number));
      const dates = rows.map(row => formatDate(row.activity_date)).sort();
      return {
        season_number: Number(season.season_number),
        status: season.status,
        daily_rows: rows.length,
        members_with_daily_records: new Set(rows.map(row => row.member)).size,
        coverage_start: dates[0] || null,
        coverage_end: dates[dates.length - 1] || null,
        tracked_calendar_days: new Set(dates).size,
      };
    });

    res.setHeader('Cache-Control', 's-maxage=15, stale-while-revalidate=15');
    return res.status(200).json({
      generated_at: Date.now(),
      timezone: 'Asia/Manila',
      active_season_number: active ? Number(active.season_number) : null,
      records,
      most_decorated: mostDecorated,
      recent_daily_records: recentDays,
      daily_tracking: {
        available: days.length > 0,
        rows: days.length,
        members: new Set(days.map(row => row.member)).size,
        coverage_start: trackedDates[0] || null,
        coverage_end: trackedDates[trackedDates.length - 1] || null,
        tracked_calendar_days: trackedDates.length,
        note: 'Daily and calendar-week records are collected from the point durable daily tracking was enabled. Older 30-day event history is not treated as a complete historical daily record.',
      },
      season_coverage: seasonCoverage,
    });
  } catch (error) {
    return res.status(502).json({
      error: error && error.message ? error.message : 'season records unavailable',
    });
  }
}
