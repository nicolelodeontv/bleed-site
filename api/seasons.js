// api/seasons.js
// Read-only Chaos season history and leaderboard.
// Uses the persistent season ledger; never contacts the game website.

const { SUPABASE_URL } = process.env;
const KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY };
const REST = SUPABASE_URL + '/rest/v1';

async function read(path, label) {
  const response = await fetch(REST + path, { headers: H });
  if (!response.ok) throw new Error(label + ' read failed: ' + response.status);
  return response.json();
}

function summarizeSeason(season, allStats, allMilestones) {
  const rows = allStats.filter(row => Number(row.season_number) === Number(season.season_number));
  const ranked = rows.slice().sort((a,b) =>
    Number(b.season_gain || 0) - Number(a.season_gain || 0) ||
    String(a.member).localeCompare(String(b.member))
  );
  const top = ranked.find(row => Number(row.season_gain || 0) > 0);
  const milestones = allMilestones.filter(row =>
    Number(row.season_number) === Number(season.season_number)
  );
  return {
    ...season,
    total_gain: rows.reduce((sum,row) => sum + Number(row.season_gain || 0), 0),
    gain_events: rows.reduce((sum,row) => sum + Number(row.gain_events || 0), 0),
    active_members: rows.filter(row => Number(row.season_gain || 0) > 0).length,
    tracked_members: rows.length,
    top_member: top ? top.member : null,
    top_member_gain: top ? Number(top.season_gain || 0) : 0,
    milestone_unlocks: milestones.length,
    major_milestone_unlocks: milestones.filter(row => row.is_major).length,
    members_with_milestones: new Set(milestones.map(row => row.member)).size,
  };
}


const RECORD_CATEGORIES = [
  { key: 'season_gain', title: 'Highest Season Gain', unit: 'rep', description: 'Most reputation gained in one tracked season' },
  { key: 'active_days', title: 'Most Active Days', unit: 'days', description: 'Most distinct Manila calendar days with recorded gains in one season' },
  { key: 'longest_streak', title: 'Longest Active Streak', unit: 'days', description: 'Most consecutive active days in one season' },
  { key: 'gain_events', title: 'Most Recorded Increases', unit: 'increases', description: 'Most positive changes detected between shared game reads in one season' },
  { key: 'best_day_gain', title: 'Best Single-Day Gain', unit: 'rep', description: 'Most reputation gained in one Manila calendar day' },
  { key: 'best_week_gain', title: 'Best Calendar-Week Gain', unit: 'rep', description: 'Most reputation gained Monday–Sunday within one season' },
];

const PERSONAL_RECORD_TITLES = {
  season_gain: 'Highest Season Gain',
  active_days: 'Most Active Days',
  longest_streak: 'Longest Active Streak',
  gain_events: 'Most Recorded Increases',
  best_day_gain: 'Best Single-Day Gain',
  best_week_gain: 'Best Calendar-Week Gain',
};

function recordFormatDate(value) {
  return value ? String(value).slice(0, 10) : null;
}

async function handleAllTimeRecords(res) {
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
    const seasonRows = Array.isArray(seasons) ? seasons : [];
    const active = seasonRows.find(row => row.status === 'active') || null;
    const seasonByNumber = new Map(seasonRows.map(row => [Number(row.season_number), row]));
    const records = RECORD_CATEGORIES.map(category => {
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
            period_start: recordFormatDate(row.period_start),
            period_end: recordFormatDate(row.period_end),
            achieved_at: row.achieved_at == null ? null : Number(row.achieved_at),
            tracked_from_legacy_season_totals: row.achieved_at == null &&
              ['season_gain','active_days','longest_streak','gain_events'].includes(category.key),
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

    const trackedDates = Array.from(new Set(days.map(row =>
      recordFormatDate(row.activity_date)
    ))).sort();
    const recentDays = days.slice(0, 30).map(row => ({
      season_number: Number(row.season_number),
      member: row.member,
      activity_date: recordFormatDate(row.activity_date),
      daily_gain: Number(row.daily_gain || 0),
      gain_events: Number(row.gain_events || 0),
      first_gain_at: Number(row.first_gain_at || 0),
      last_gain_at: Number(row.last_gain_at || 0),
    }));

    const seasonCoverage = seasonRows.map(season => {
      const rows = days.filter(row =>
        Number(row.season_number) === Number(season.season_number)
      );
      const dates = rows.map(row => recordFormatDate(row.activity_date)).sort();
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
      member_count: decorated.size,
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

async function handleMemberRecords(req, res) {
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

    const [recordsRows, dailyRows, statsRows, seasons] = await Promise.all([
      read('/chaos_personal_best_records?' + recordsQuery.toString(), 'Member personal records'),
      read('/chaos_season_daily_stats?' + dailyQuery.toString(), 'Member daily history'),
      read('/chaos_season_member_stats?' + statsQuery.toString(), 'Member season totals'),
      read('/chaos_seasons?' + seasonsQuery.toString(), 'Season history'),
    ]);

    const records = (Array.isArray(recordsRows) ? recordsRows : []).map(row => ({
      record_key: row.record_key,
      record_title: row.record_title || PERSONAL_RECORD_TITLES[row.record_key] || row.record_key,
      record_value: Number(row.record_value || 0),
      season_number: Number(row.season_number),
      period_start: row.period_start || null,
      period_end: row.period_end || null,
      achieved_at: row.achieved_at == null ? null : Number(row.achieved_at),
      date_known: row.achieved_at != null,
    }));

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
      const weekStart = d.toISOString().slice(0,10);
      const key = Number(row.season_number) + '|' + weekStart;
      if (!weekTotals.has(key)) weekTotals.set(key, {
        season_number: Number(row.season_number),
        week_start: weekStart,
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
      records,
      record_count: records.length,
      season_count: stats.length,
      seasons_with_daily_history: new Set(days.map(row => Number(row.season_number))).size,
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

export default async function handler(req, res) {
  if (req.query.view === 'records') return handleAllTimeRecords(res);
  if (req.query.view === 'member-records') return handleMemberRecords(req,res);

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method not allowed' });
  }
  if (!SUPABASE_URL || !KEY) {
    return res.status(500).json({ error: 'season tracking is not configured' });
  }

  const hasSeason = req.query.season !== undefined && req.query.season !== '';
  const requestedSeason = hasSeason && typeof req.query.season === 'string'
    ? Number(req.query.season) : null;
  if (hasSeason && (!Number.isSafeInteger(requestedSeason) || requestedSeason < 1)) {
    return res.status(400).json({ error: 'invalid season number' });
  }

  try {
    const [seasons, allStats, allMilestones, allPersonalBests] = await Promise.all([
      read('/chaos_seasons?select=season_number,started_at,ended_at,status,start_reason,end_reason&order=season_number.desc&limit=100', 'Season history'),
      read('/chaos_season_member_stats?select=season_number,member,starting_rep,current_rep,season_gain,gain_events,active_days,last_gain_at,last_gain_day,current_streak_days,longest_streak_days,last_streak_day,updated_at&order=season_number.desc,season_gain.desc&limit=10000', 'Season member totals'),
      read('/chaos_season_milestones?select=id,season_number,member,milestone_key,milestone_value,milestone_title,metric_value,earned_at,is_major&order=season_number.desc,earned_at.desc&limit=20000', 'Season milestone totals'),
      read('/chaos_personal_best_records?select=member,record_key,record_title,record_value,season_number&period_start,period_end,achieved_at&order=record_key.asc,record_value.desc&limit=10000', 'Personal best records'),
    ]);

    if (!Array.isArray(seasons) || !seasons.length) {
      return res.status(404).json({ error: 'No Chaos seasons have been recorded yet.' });
    }

    const milestoneRows = Array.isArray(allMilestones) ? allMilestones : [];
    const summaries = seasons.map(season =>
      summarizeSeason(season, Array.isArray(allStats) ? allStats : [], milestoneRows)
    );
    const active = seasons.find(season => season.status === 'active') || seasons[0];
    const selected = requestedSeason == null
      ? active
      : seasons.find(season => Number(season.season_number) === requestedSeason);

    if (!selected) return res.status(404).json({ error: 'That season was not found.' });

    const personalBestRows = Array.isArray(allPersonalBests) ? allPersonalBests : [];
    const selectedPersonalBests = new Map();
    for (const record of personalBestRows.filter(item =>
      Number(item.season_number) === Number(selected.season_number)
    )) {
      if (!selectedPersonalBests.has(record.member)) selectedPersonalBests.set(record.member, []);
      selectedPersonalBests.get(record.member).push({
        record_key: record.record_key,
        record_title: record.record_title,
        record_value: Number(record.record_value || 0),
      });
    }

    const selectedMilestones = new Map();
    for (const row of milestoneRows.filter(item =>
      Number(item.season_number) === Number(selected.season_number)
    )) {
      if (!selectedMilestones.has(row.member)) selectedMilestones.set(row.member, []);
      selectedMilestones.get(row.member).push({
        id: Number(row.id),
        milestone_key: row.milestone_key,
        milestone_value: Number(row.milestone_value || 0),
        milestone_title: row.milestone_title,
        metric_value: Number(row.metric_value || 0),
        earned_at: Number(row.earned_at || 0),
        is_major: !!row.is_major,
      });
    }

    const selectedMembers = (Array.isArray(allStats) ? allStats : [])
      .filter(row => Number(row.season_number) === Number(selected.season_number))
      .sort((a,b) => Number(b.season_gain || 0) - Number(a.season_gain || 0) ||
        String(a.member).localeCompare(String(b.member)))
      .map((row,index) => ({
        ...row,
        current_streak_days: Number(row.current_streak_days || 0),
        longest_streak_days: Number(row.longest_streak_days || 0),
        milestones: selectedMilestones.get(row.member) || [],
        records_held: selectedPersonalBests.get(row.member) || [],
        rank: index + 1,
      }));

    const summary = summaries.find(item => Number(item.season_number) === Number(selected.season_number));
    const previous = summaries
      .filter(item => Number(item.season_number) < Number(selected.season_number))
      .sort((a,b) => Number(b.season_number) - Number(a.season_number))[0] || null;

    res.setHeader('Cache-Control', 's-maxage=15, stale-while-revalidate=15');
    return res.status(200).json({
      generated_at: Date.now(),
      timezone: 'Asia/Manila',
      active_season_number: Number(active.season_number),
      selected_season: summary,
      previous_season: previous,
      seasons: summaries,
      members: selectedMembers,
      milestone_totals: {
        unlocks: milestoneRows.length,
        major_unlocks: milestoneRows.filter(row => row.is_major).length,
      },
      personal_record_totals: {
        records: personalBestRows.length,
        holders: new Set(personalBestRows.map(row => row.member)).size,
        selected_season_holders: selectedMembers.filter(row => row.records_held.length > 0).length,
      },
    });
  } catch (error) {
    return res.status(502).json({ error: error && error.message ? error.message : 'season data unavailable' });
  }
}
