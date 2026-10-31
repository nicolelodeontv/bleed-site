// api/season-comparison.js
// Read-only season-to-season comparison using the persistent season ledger.
const { SUPABASE_URL } = process.env;
const KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const HEADERS = { apikey: KEY, Authorization: 'Bearer ' + KEY };
const REST = SUPABASE_URL ? SUPABASE_URL.replace(/\/$/, '') + '/rest/v1' : '';

async function read(path, label) {
  const response = await fetch(REST + path, { headers: HEADERS });
  if (!response.ok) throw new Error(label + ' read failed: ' + response.status);
  return response.json();
}

function dateOnly(value) {
  return String(value || '').slice(0, 10);
}

function summarizeSeason(season, allStats, allDaily, allRankings) {
  const number = Number(season.season_number);
  const stats = allStats.filter(row => Number(row.season_number) === number);
  const ranked = stats.slice().sort((a, b) =>
    Number(b.season_gain || 0) - Number(a.season_gain || 0) ||
    String(a.member).localeCompare(String(b.member))
  );
  const daily = allDaily.filter(row => Number(row.season_number) === number);
  const rankings = allRankings.filter(row => Number(row.season_number) === number);
  const dailyDates = Array.from(new Set(daily.map(row => dateOnly(row.activity_date)).filter(Boolean))).sort();
  const rankingDates = Array.from(new Set(rankings.map(row => dateOnly(row.snapshot_date)).filter(Boolean))).sort();
  const startedAt = Number(season.started_at || 0);
  const endedAt = season.ended_at == null ? Date.now() : Number(season.ended_at);
  const elapsedDays = startedAt > 0
    ? Math.max(1, Math.ceil(Math.max(0, endedAt - startedAt) / 86400000))
    : null;
  const totalGain = stats.reduce((sum, row) => sum + Number(row.season_gain || 0), 0);
  const activeMembers = stats.filter(row => Number(row.season_gain || 0) > 0).length;
  const events = stats.reduce((sum, row) => sum + Number(row.gain_events || 0), 0);
  const topMember = ranked.find(row => Number(row.season_gain || 0) > 0) || null;
  return {
    season_number: number,
    status: season.status,
    start_reason: season.start_reason || null,
    started_at: startedAt || null,
    ended_at: season.ended_at == null ? null : Number(season.ended_at),
    elapsed_days: elapsedDays,
    total_gain: totalGain,
    gain_events: events,
    tracked_members: stats.length,
    active_members: activeMembers,
    member_active_days: stats.reduce((sum, row) => sum + Number(row.active_days || 0), 0),
    average_active_days_per_member: stats.length
      ? stats.reduce((sum, row) => sum + Number(row.active_days || 0), 0) / stats.length : 0,
    average_gain_per_calendar_day: elapsedDays ? totalGain / elapsedDays : null,
    average_gain_per_active_member: activeMembers ? totalGain / activeMembers : 0,
    top_member: topMember ? topMember.member : null,
    top_member_gain: topMember ? Number(topMember.season_gain || 0) : 0,
    daily_coverage_days: dailyDates.length,
    daily_coverage_start: dailyDates[0] || null,
    daily_coverage_end: dailyDates[dailyDates.length - 1] || null,
    daily_ledger_gain: daily.reduce((sum, row) => sum + Number(row.daily_gain || 0), 0),
    rank_snapshot_days: rankingDates.length,
    rank_snapshot_start: rankingDates[0] || null,
    rank_snapshot_end: rankingDates[rankingDates.length - 1] || null,
    top_gainers: ranked.filter(row => Number(row.season_gain || 0) > 0).slice(0, 10).map((row, index) => ({
      rank: index + 1,
      member: row.member,
      season_gain: Number(row.season_gain || 0),
      gain_events: Number(row.gain_events || 0),
      active_days: Number(row.active_days || 0),
      longest_streak_days: Number(row.longest_streak_days || 0),
    })),
    top_consistency: stats.slice().sort((a, b) =>
      Number(b.longest_streak_days || 0) - Number(a.longest_streak_days || 0) ||
      Number(b.active_days || 0) - Number(a.active_days || 0) ||
      String(a.member).localeCompare(String(b.member))
    ).filter(row => Number(row.active_days || 0) > 0).slice(0, 10).map(row => ({
      member: row.member,
      active_days: Number(row.active_days || 0),
      longest_streak_days: Number(row.longest_streak_days || 0),
      season_gain: Number(row.season_gain || 0),
    })),
    members: ranked.map((row, index) => ({
      rank: index + 1,
      member: row.member,
      season_gain: Number(row.season_gain || 0),
      gain_events: Number(row.gain_events || 0),
      active_days: Number(row.active_days || 0),
      longest_streak_days: Number(row.longest_streak_days || 0),
    })),
  };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method not allowed' });
  }
  if (!SUPABASE_URL || !KEY) {
    return res.status(500).json({ error: 'season comparison is not configured' });
  }

  const rawA = req.query.season_a;
  const rawB = req.query.season_b;
  const parseSeason = value => {
    if (value == null || value === '') return null;
    if (typeof value !== 'string' || !/^\d+$/.test(value)) return NaN;
    const number = Number(value);
    return Number.isSafeInteger(number) && number > 0 ? number : NaN;
  };
  const requestedA = parseSeason(rawA);
  const requestedB = parseSeason(rawB);
  if (Number.isNaN(requestedA) || Number.isNaN(requestedB)) {
    return res.status(400).json({ error: 'invalid season number' });
  }
  if ((requestedA == null) !== (requestedB == null)) {
    return res.status(400).json({ error: 'select both seasons to compare' });
  }
  if (requestedA != null && requestedA === requestedB) {
    return res.status(400).json({ error: 'choose two different seasons' });
  }

  try {
    const [seasonRows, statsRows, dailyRows, rankingRows] = await Promise.all([
      read('/chaos_seasons?select=season_number,started_at,ended_at,status,start_reason,end_reason&order=season_number.desc&limit=100', 'Season history'),
      read('/chaos_season_member_stats?select=season_number,member,starting_rep,current_rep,season_gain,gain_events,active_days,current_streak_days,longest_streak_days,last_gain_day&order=season_number.desc,season_gain.desc&limit=20000', 'Season member totals'),
      read('/chaos_season_daily_stats?select=season_number,member,activity_date,daily_gain,gain_events&order=activity_date.desc&limit=50000', 'Daily season history'),
      read('/chaos_season_daily_rankings?select=season_number,snapshot_date&order=snapshot_date.desc&limit=50000', 'Daily ranking coverage'),
    ]);

    const seasons = Array.isArray(seasonRows) ? seasonRows : [];
    if (!seasons.length) return res.status(404).json({ error: 'No recorded seasons were found.' });
    const allStats = Array.isArray(statsRows) ? statsRows : [];
    const allDaily = Array.isArray(dailyRows) ? dailyRows : [];
    const allRankings = Array.isArray(rankingRows) ? rankingRows : [];
    const summaries = seasons.map(season => summarizeSeason(season, allStats, allDaily, allRankings));
    const latestSeason = seasons.find(row => row.status === 'active') || seasons[0];
    const latestSummary = summaries.find(row => row.season_number === Number(latestSeason.season_number));
    const previousSeason = seasons
      .filter(row => Number(row.season_number) < Number(latestSeason.season_number))
      .sort((a, b) => Number(b.season_number) - Number(a.season_number))[0] || null;

    let selectedA = requestedA;
    let selectedB = requestedB;
    if (selectedA == null && previousSeason) {
      selectedA = Number(previousSeason.season_number);
      selectedB = Number(latestSeason.season_number);
    }
    const seasonA = selectedA == null
      ? null : summaries.find(row => row.season_number === selectedA) || null;
    const seasonB = selectedB == null
      ? null : summaries.find(row => row.season_number === selectedB) || null;
    if (requestedA != null && (!seasonA || !seasonB)) {
      return res.status(404).json({ error: 'One or both selected seasons were not found.' });
    }

    let memberComparisons = [];
    if (seasonA && seasonB) {
      const rowsA = new Map(seasonA.members.map(row => [row.member, row]));
      const rowsB = new Map(seasonB.members.map(row => [row.member, row]));
      const names = new Set([...rowsA.keys(), ...rowsB.keys()]);
      memberComparisons = Array.from(names).map(member => {
        const a = rowsA.get(member) || null;
        const b = rowsB.get(member) || null;
        const gainChange = a && b ? b.season_gain - a.season_gain : null;
        const eventChange = a && b ? b.gain_events - a.gain_events : null;
        return {
          member,
          season_a: a ? { rank: a.rank, season_gain: a.season_gain, gain_events: a.gain_events, active_days: a.active_days, longest_streak_days: a.longest_streak_days } : null,
          season_b: b ? { rank: b.rank, season_gain: b.season_gain, gain_events: b.gain_events, active_days: b.active_days, longest_streak_days: b.longest_streak_days } : null,
          gain_change: gainChange,
          gain_change_percent: a && b && a.season_gain > 0 ? (gainChange / a.season_gain) * 100 : null,
          active_days_change: a && b ? b.active_days - a.active_days : null,
          events_change: eventChange,
          status: a && b ? 'both seasons' : b ? 'new in season B' : 'not in season B',
        };
      }).sort((a, b) => {
        if (a.gain_change == null && b.gain_change != null) return 1;
        if (a.gain_change != null && b.gain_change == null) return -1;
        return Math.abs(b.gain_change || 0) - Math.abs(a.gain_change || 0) ||
          Number(b.season_b?.season_gain || 0) - Number(a.season_b?.season_gain || 0) ||
          a.member.localeCompare(b.member);
      });
    }

    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=30');
    return res.status(200).json({
      generated_at: Date.now(),
      timezone: 'Asia/Manila',
      comparison_available: !!(seasonA && seasonB),
      latest_season: latestSummary,
      season_a: seasonA ? { ...seasonA, members: undefined } : null,
      season_b: seasonB ? { ...seasonB, members: undefined } : null,
      selected_season_a: seasonA ? seasonA.season_number : null,
      selected_season_b: seasonB ? seasonB.season_number : null,
      seasons: summaries.map(row => ({ ...row, members: undefined })),
      latest_members: latestSummary ? latestSummary.members : [],
      member_comparisons: memberComparisons,
      notes: {
        total_gain: 'Season totals come from the persistent per-member season ledger.',
        average_gain_per_calendar_day: 'Average gain divides the season total by elapsed calendar days from the recorded season start through the end date (or now for an active season).',
        daily_coverage: 'Daily ledger and rank-snapshot coverage are reported separately. Earlier daily history is not backfilled or inferred from season totals.',
        missing_member: 'A dash means no member row exists for that season; it is not treated as a zero-gain result.',
      },
    });
  } catch (error) {
    return res.status(502).json({
      error: error && error.message ? error.message : 'season comparison unavailable',
    });
  }
}
