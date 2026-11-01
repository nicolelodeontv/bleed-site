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


function analyticsDate(value) {
  return String(value || '').slice(0, 10);
}

function analyticsAddDays(value, amount) {
  const date = new Date(analyticsDate(value) + 'T00:00:00Z');
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function analyticsWeekStart(value) {
  const date = new Date(analyticsDate(value) + 'T00:00:00Z');
  const weekday = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() - weekday + 1);
  return date.toISOString().slice(0, 10);
}

function analyticsBuildWeek(rows, start, end) {
  const members = new Map();
  let totalGain = 0;
  let totalEvents = 0;
  const dates = new Set();
  for (const row of rows) {
    const date = analyticsDate(row.activity_date);
    if (date < start || date > end) continue;
    const gain = Number(row.daily_gain || 0);
    const events = Number(row.gain_events || 0);
    totalGain += gain;
    totalEvents += events;
    dates.add(date);
    if (!members.has(row.member)) members.set(row.member, {
      member: row.member, gain: 0, events: 0, active_days: 0,
    });
    const item = members.get(row.member);
    item.gain += gain;
    item.events += events;
    item.active_days++;
  }
  const leaders = Array.from(members.values()).sort((a,b) =>
    b.gain - a.gain || b.events - a.events || a.member.localeCompare(b.member)
  );
  const mostActive = Array.from(members.values()).sort((a,b) =>
    b.active_days - a.active_days || b.gain - a.gain || a.member.localeCompare(b.member)
  );
  return {
    start, end,
    total_gain: totalGain,
    total_events: totalEvents,
    active_members: members.size,
    active_days: dates.size,
    top_gainers: leaders.slice(0, 5),
    top_active_members: mostActive.slice(0, 5),
    member_gains: leaders,
  };
}

async function handleSeasonAnalytics(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method not allowed' });
  }
  if (!SUPABASE_URL || !KEY) {
    return res.status(500).json({ error: 'season analytics are not configured' });
  }

  const rawSeason = req.query.season;
  const requestedSeason = rawSeason == null || rawSeason === ''
    ? null : (typeof rawSeason === 'string' ? Number(rawSeason) : NaN);
  if (rawSeason != null && rawSeason !== '' &&
      (!Number.isSafeInteger(requestedSeason) || requestedSeason < 1)) {
    return res.status(400).json({ error: 'invalid season number' });
  }

  try {
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
    const trackingStart = analyticsAddDays(today, -89);
    const [seasonRows] = await Promise.all([
      read('/chaos_seasons?select=season_number,started_at,ended_at,status&order=season_number.desc&limit=100', 'Season history'),
    ]);
    const seasonList = Array.isArray(seasonRows) ? seasonRows : [];
    const activeSeason = seasonList.find(row => row.status === 'active') || seasonList[0] || null;
    const selectedSeason = requestedSeason == null
      ? activeSeason
      : seasonList.find(row => Number(row.season_number) === requestedSeason);
    if (!selectedSeason) return res.status(404).json({ error: 'That season was not found.' });

    const seasonNumber = Number(selectedSeason.season_number);
    const dailyQuery = new URLSearchParams({
      select: 'season_number,member,activity_date,daily_gain,gain_events',
      season_number: 'eq.' + seasonNumber,
      activity_date: 'gte.' + trackingStart,
      order: 'activity_date.desc,daily_gain.desc,member.asc',
      limit: '10000',
    });
    const rankingQuery = new URLSearchParams({
      select: 'season_number,member,snapshot_date,rank_position,season_gain,gain_events,active_days,current_rep,captured_at',
      season_number: 'eq.' + seasonNumber,
      snapshot_date: 'gte.' + trackingStart,
      order: 'snapshot_date.desc,rank_position.asc',
      limit: '10000',
    });
    const statsQuery = new URLSearchParams({
      select: 'member,current_rep,season_gain,gain_events,active_days,last_gain_day',
      season_number: 'eq.' + seasonNumber,
      order: 'season_gain.desc,member.asc',
      limit: '1000',
    });

    const reportWeekStart = analyticsWeekStart(today);
    const reportWeekEnd = analyticsAddDays(today, 1);
    const recordQuery = new URLSearchParams({
      select: 'member,record_key,record_title,record_value,season_number,achieved_at',
      season_number: 'eq.' + seasonNumber,
      achieved_at: 'gte.' + Date.parse(reportWeekStart + 'T00:00:00+08:00'),
      order: 'achieved_at.desc',
      limit: '1000',
    });
    recordQuery.append('achieved_at', 'lt.' + Date.parse(reportWeekEnd + 'T00:00:00+08:00'));
    const [dailyResult, rankingResult, statsResult, recordResult] = await Promise.all([
      read('/chaos_season_daily_stats?' + dailyQuery.toString(), 'Daily season analytics'),
      read('/chaos_season_daily_rankings?' + rankingQuery.toString(), 'Daily leaderboard snapshots'),
      read('/chaos_season_member_stats?' + statsQuery.toString(), 'Current season member totals'),
      read('/chaos_personal_best_records?' + recordQuery.toString(), 'Weekly personal records'),
    ]);
    const dailyRows = Array.isArray(dailyResult) ? dailyResult : [];
    const rankingRows = Array.isArray(rankingResult) ? rankingResult : [];
    const statsRows = Array.isArray(statsResult) ? statsResult : [];
    const recordRows = Array.isArray(recordResult) ? recordResult : [];

    const dayMap = new Map();
    const memberTotals = new Map();
    const memberDayMap = new Map();
    for (const row of dailyRows) {
      const date = analyticsDate(row.activity_date);
      const gain = Number(row.daily_gain || 0);
      const events = Number(row.gain_events || 0);
      if (!dayMap.has(date)) dayMap.set(date, {
        date, gain: 0, events: 0, active_members: new Set(),
      });
      const day = dayMap.get(date);
      day.gain += gain;
      day.events += events;
      day.active_members.add(row.member);

      if (!memberTotals.has(row.member)) memberTotals.set(row.member, {
        member: row.member, gain: 0, events: 0, active_days: 0,
      });
      const total = memberTotals.get(row.member);
      total.gain += gain;
      total.events += events;
      total.active_days++;

      memberDayMap.set(row.member + '|' + date, { gain, events });
    }

    const rankingDates = Array.from(new Set(rankingRows.map(row =>
      analyticsDate(row.snapshot_date)
    ))).filter(Boolean).sort();
    const rankingDateSet = new Set(rankingDates);
    const coverageDates = Array.from(new Set([
      ...rankingDates,
      ...Array.from(dayMap.keys()),
    ])).sort();
    const dailyTotals = coverageDates.map(date => {
      const row = dayMap.get(date);
      return {
        date,
        gain: row ? row.gain : 0,
        events: row ? row.events : 0,
        active_members: row ? row.active_members.size : 0,
        snapshot_saved: rankingDateSet.has(date),
      };
    });
    const dailyFirst = rankingDates[0] || null;
    const dailyLast = rankingDates[rankingDates.length - 1] || null;
    function hasTrackedDates(start, end) {
      const expected = [];
      for (let date = start; date <= end; date = analyticsAddDays(date, 1)) expected.push(date);
      return expected.length > 0 && expected.every(date => rankingDateSet.has(date));
    }

    const heatmapStart = analyticsAddDays(today, -55);
    const heatmapDates = Array.from({length:56}, (_,i) => analyticsAddDays(heatmapStart, i));
    const heatmapMembers = Array.from(memberTotals.values())
      .sort((a,b) => b.gain - a.gain || a.member.localeCompare(b.member))
      .slice(0, 18)
      .map(member => ({
        member: member.member,
        total_gain: member.gain,
        days: heatmapDates.map(date => {
          const value = memberDayMap.get(member.member + '|' + date);
          return { date, gain: value ? value.gain : 0, events: value ? value.events : 0 };
        }),
      }));

    const currentWeekStart = analyticsWeekStart(today);
    const previousWeekStart = analyticsAddDays(currentWeekStart, -7);
    const previousWeekEnd = analyticsAddDays(currentWeekStart, -1);
    const currentWeek = analyticsBuildWeek(dailyRows, currentWeekStart, today);
    const previousWeek = analyticsBuildWeek(dailyRows, previousWeekStart, previousWeekEnd);
    const weeklyHistoryReady = hasTrackedDates(previousWeekStart, previousWeekEnd);
    const currentWeekMembers = currentWeek.member_gains;
    const previousWeekMembers = previousWeek.member_gains;
    delete currentWeek.member_gains;
    delete previousWeek.member_gains;
    const previousWeekMap = new Map(previousWeekMembers.map(row => [row.member, row]));
    const biggestImprovements = weeklyHistoryReady
      ? currentWeekMembers.map(row => {
          const previous = previousWeekMap.get(row.member);
          return {
            member: row.member,
            current_gain: row.gain,
            previous_gain: previous ? previous.gain : 0,
            improvement: row.gain - (previous ? previous.gain : 0),
          };
        }).sort((a,b) => b.improvement - a.improvement || a.member.localeCompare(b.member))
          .filter(row => row.improvement > 0).slice(0, 5)
      : [];
    const notableRecords = recordRows.map(row => ({
      member: row.member,
      record_key: row.record_key,
      record_title: row.record_title,
      record_value: Number(row.record_value || 0),
      achieved_at: Number(row.achieved_at || 0),
    })).filter(row => row.achieved_at > 0);

    const momentumReady = hasTrackedDates(analyticsAddDays(today, -13), today);
    const momentum = statsRows.map(row => {
      const currentGain = dailyRows.filter(item =>
        item.member === row.member &&
        analyticsDate(item.activity_date) >= analyticsAddDays(today, -6) &&
        analyticsDate(item.activity_date) <= today
      ).reduce((sum,item) => sum + Number(item.daily_gain || 0), 0);
      const previousGain = dailyRows.filter(item =>
        item.member === row.member &&
        analyticsDate(item.activity_date) >= analyticsAddDays(today, -13) &&
        analyticsDate(item.activity_date) <= analyticsAddDays(today, -7)
      ).reduce((sum,item) => sum + Number(item.daily_gain || 0), 0);
      let status = 'not enough history';
      if (momentumReady) {
        if (previousGain === 0 && currentGain > 0) status = 'started';
        else if (previousGain === 0 && currentGain === 0) status = 'no gains';
        else if (currentGain > previousGain * 1.1) status = 'increasing';
        else if (currentGain < previousGain * 0.9) status = 'slowing';
        else status = 'steady';
      }
      return {
        member: row.member,
        current_rep: Number(row.current_rep || 0),
        season_gain: Number(row.season_gain || 0),
        last_7d_gain: currentGain,
        previous_7d_gain: previousGain,
        change: currentGain - previousGain,
        status,
      };
    }).sort((a,b) =>
      b.last_7d_gain - a.last_7d_gain ||
      b.season_gain - a.season_gain ||
      a.member.localeCompare(b.member)
    );

    const sortedSnapshots = rankingRows.slice().sort((a,b) =>
      analyticsDate(b.snapshot_date).localeCompare(analyticsDate(a.snapshot_date)) ||
      Number(a.rank_position) - Number(b.rank_position)
    );
    const currentSnapshotDate = sortedSnapshots.length
      ? analyticsDate(sortedSnapshots[0].snapshot_date) : null;
    const baselineTarget = analyticsAddDays(today, -7);
    const baselineSnapshotDate = sortedSnapshots
      .map(row => analyticsDate(row.snapshot_date))
      .filter(date => date <= baselineTarget)
      .sort()
      .slice(-1)[0] || null;
    const currentRanks = new Map();
    const previousRanks = new Map();
    for (const row of sortedSnapshots) {
      const date = analyticsDate(row.snapshot_date);
      if (date === currentSnapshotDate && !currentRanks.has(row.member)) currentRanks.set(row.member, row);
      if (date === baselineSnapshotDate && !previousRanks.has(row.member)) previousRanks.set(row.member, row);
    }
    const rankMovement = Array.from(currentRanks.values()).map(row => {
      const previous = previousRanks.get(row.member) || null;
      const currentRank = Number(row.rank_position);
      const previousRank = previous ? Number(previous.rank_position) : null;
      return {
        member: row.member,
        rank: currentRank,
        previous_rank: previousRank,
        rank_change: previousRank == null ? null : previousRank - currentRank,
        season_gain: Number(row.season_gain || 0),
        current_rep: Number(row.current_rep || 0),
        previous_snapshot_date: previous ? baselineSnapshotDate : null,
      };
    }).sort((a,b) => a.rank - b.rank);

    const latestDay = dailyTotals[dailyTotals.length - 1] || null;
    const cumulativeGain = dailyTotals.reduce((sum,row) => sum + row.gain, 0);
    res.setHeader('Cache-Control', 's-maxage=20, stale-while-revalidate=30');
    return res.status(200).json({
      generated_at: Date.now(),
      timezone: 'Asia/Manila',
      today,
      season: {
        season_number: seasonNumber,
        status: selectedSeason.status,
        started_at: Number(selectedSeason.started_at || 0),
        ended_at: selectedSeason.ended_at == null ? null : Number(selectedSeason.ended_at),
      },
      seasons: seasonList.map(row => ({
        season_number: Number(row.season_number),
        status: row.status,
        started_at: Number(row.started_at || 0),
        ended_at: row.ended_at == null ? null : Number(row.ended_at),
      })),
      summary: {
        total_gain_tracked: cumulativeGain,
        tracked_days: rankingDates.length,
        days_with_gains: Array.from(dayMap.keys()).length,
        first_tracked_day: dailyFirst,
        last_tracked_day: dailyLast,
        active_members: new Set(dailyRows.map(row => row.member)).size,
        total_gain_today: latestDay && latestDay.date === today ? latestDay.gain : 0,
        current_week_gain: currentWeek.total_gain,
        current_week_members: currentWeek.active_members,
        ranking_snapshot_date: currentSnapshotDate,
        ranking_baseline_date: baselineSnapshotDate,
        ranking_members: currentRanks.size,
      },
      daily_totals: dailyTotals,
      member_daily_activity: dailyRows.map(row => ({
        date: analyticsDate(row.activity_date),
        member: row.member,
        gain: Number(row.daily_gain || 0),
        events: Number(row.gain_events || 0),
      })),
      member_season_stats: statsRows.map(row => ({
        member: row.member,
        current_rep: Number(row.current_rep || 0),
        season_gain: Number(row.season_gain || 0),
        gain_events: Number(row.gain_events || 0),
        active_days: Number(row.active_days || 0),
        last_gain_day: analyticsDate(row.last_gain_day),
      })),
      leaderboard_history: rankingRows.map(row => ({
        date: analyticsDate(row.snapshot_date),
        member: row.member,
        rank: Number(row.rank_position || 0),
        season_gain: Number(row.season_gain || 0),
        gain_events: Number(row.gain_events || 0),
        active_days: Number(row.active_days || 0),
        current_rep: Number(row.current_rep || 0),
        captured_at: Number(row.captured_at || 0),
      })),
      heatmap: {
        start: heatmapStart,
        end: today,
        dates: heatmapDates,
        members: heatmapMembers,
      },
      weekly: {
        current: currentWeek,
        previous: previousWeek,
        improvements_available: weeklyHistoryReady,
        biggest_improvements: biggestImprovements,
        notable_records: notableRecords.slice(0, 10),
        note: weeklyHistoryReady
          ? 'Week-over-week improvements compare complete saved calendar weeks.'
          : 'Biggest improvements are withheld until all 7 dates in the previous calendar week have saved daily rank snapshots.',
      },
      momentum: {
        available: momentumReady,
        comparison_days: 7,
        note: momentumReady
          ? 'Compares the latest 7 Manila calendar days with the preceding 7 days.'
          : 'Momentum labels are withheld until 14 consecutive calendar dates have saved daily rank snapshots.',
        members: momentum,
      },
      rank_movement: {
        available: !!baselineSnapshotDate,
        comparison_date: baselineSnapshotDate,
        current_date: currentSnapshotDate,
        members: rankMovement,
        note: baselineSnapshotDate
          ? 'Rank changes compare the latest saved daily snapshot with the latest snapshot on or before seven days earlier.'
          : 'Rank movement becomes available after at least eight calendar days of daily rank snapshots.',
      },
      daily_tracking_note: 'Zero-gain days are included only when a daily ranking snapshot confirms that the tracker ran. Daily totals and rank history begin with the first saved snapshot; earlier event history is not presented as complete daily history.',
    });
  } catch (error) {
    return res.status(502).json({
      error: error && error.message ? error.message : 'season analytics unavailable',
    });
  }
}

function comparisonDateOnly(value) {
  return String(value || '').slice(0, 10);
}

function summarizeComparisonSeason(season, allStats, allDaily, allRankings) {
  const number = Number(season.season_number);
  const stats = allStats.filter(row => Number(row.season_number) === number);
  const ranked = stats.slice().sort((a, b) =>
    Number(b.season_gain || 0) - Number(a.season_gain || 0) ||
    String(a.member).localeCompare(String(b.member))
  );
  const daily = allDaily.filter(row => Number(row.season_number) === number);
  const rankings = allRankings.filter(row => Number(row.season_number) === number);
  const dailyDates = Array.from(new Set(daily.map(row => comparisonDateOnly(row.activity_date)).filter(Boolean))).sort();
  const rankingDates = Array.from(new Set(rankings.map(row => comparisonDateOnly(row.snapshot_date)).filter(Boolean))).sort();
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

async function handleSeasonComparison(req, res) {
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
    const summaries = seasons.map(season => summarizeComparisonSeason(season, allStats, allDaily, allRankings));
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



function retentionDateOnly(value) {
  return String(value || '').slice(0, 10);
}

function retentionAddDays(value, amount) {
  const date = new Date(retentionDateOnly(value) + 'T00:00:00Z');
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function retentionDayDiff(from, to) {
  const a = new Date(retentionDateOnly(from) + 'T00:00:00Z').getTime();
  const b = new Date(retentionDateOnly(to) + 'T00:00:00Z').getTime();
  return Number.isFinite(a) && Number.isFinite(b)
    ? Math.max(0, Math.floor((b - a) / 86400000)) : 0;
}

function retentionManilaDay(timestamp) {
  const value = Number(timestamp);
  if (!Number.isFinite(value) || value <= 0) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(value));
}

async function handleMemberRetention(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method not allowed' });
  }
  if (!SUPABASE_URL || !KEY) {
    return res.status(500).json({ error: 'member retention is not configured' });
  }

  try {
    const seasonRows = await read(
      '/chaos_seasons?select=season_number,started_at,ended_at,status&order=season_number.desc&limit=100',
      'Retention season history'
    );
    const seasons = Array.isArray(seasonRows) ? seasonRows : [];
    const season = seasons.find(row => row.status === 'active') || seasons[0] || null;
    if (!season) return res.status(404).json({ error: 'No tracked Chaos season was found.' });

    const seasonNumber = Number(season.season_number);
    const [statsRaw, dailyRaw, rankingsRaw] = await Promise.all([
      read('/chaos_season_member_stats?select=season_number,member,season_gain,gain_events,active_days,last_gain_at,last_gain_day,updated_at&season_number=eq.' +
        seasonNumber + '&order=member.asc&limit=1000', 'Retention member totals'),
      read('/chaos_season_daily_stats?select=member,activity_date,daily_gain,gain_events&season_number=eq.' +
        seasonNumber + '&order=activity_date.asc,member.asc&limit=50000', 'Retention daily activity'),
      read('/chaos_season_daily_rankings?select=snapshot_date&season_number=eq.' +
        seasonNumber + '&order=snapshot_date.asc&limit=50000', 'Retention daily coverage'),
    ]);

    const stats = Array.isArray(statsRaw) ? statsRaw : [];
    const daily = Array.isArray(dailyRaw) ? dailyRaw : [];
    const rankRows = Array.isArray(rankingsRaw) ? rankingsRaw : [];
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
    const seasonStartDay = retentionManilaDay(season.started_at) ||
      retentionDateOnly(season.started_at);
    const snapshotDates = Array.from(new Set(rankRows.map(row =>
      retentionDateOnly(row.snapshot_date)
    ).filter(Boolean))).sort();
    const dailyDates = Array.from(new Set(daily.map(row =>
      retentionDateOnly(row.activity_date)
    ).filter(Boolean))).sort();
    const coverageDates = snapshotDates.length ? snapshotDates : dailyDates;
    const coverageStart = coverageDates[0] || dailyDates[0] || null;
    const coverageEnd = coverageDates[coverageDates.length - 1] || dailyDates[dailyDates.length - 1] || null;

    const dailyByMember = new Map();
    for (const row of daily) {
      const name = String(row.member || '');
      if (!name) continue;
      if (!dailyByMember.has(name)) dailyByMember.set(name, []);
      dailyByMember.get(name).push({
        day: retentionDateOnly(row.activity_date),
        gain: Number(row.daily_gain || 0),
        events: Number(row.gain_events || 0),
      });
    }

    const previousStart = retentionAddDays(today, -14);
    const previousEnd = retentionAddDays(today, -8);
    const currentStart = retentionAddDays(today, -7);
    const currentEnd = retentionAddDays(today, -1);
    const requiredDates = [];
    for (let date = previousStart; date <= currentEnd; date = retentionAddDays(date, 1)) {
      requiredDates.push(date);
    }
    const covered = new Set(snapshotDates);
    const coverageComplete = snapshotDates.length >= 14 &&
      requiredDates.every(date => covered.has(date));
    const trendAvailable = coverageComplete && daily.length > 0;

    const members = stats.map(row => {
      const member = String(row.member || '');
      const memberDays = (dailyByMember.get(member) || []).slice()
        .sort((a, b) => a.day.localeCompare(b.day));
      const latestDailyDay = memberDays.length ? memberDays[memberDays.length - 1].day : null;
      const lastGainAt = row.last_gain_at == null ? null : Number(row.last_gain_at);
      const lastGainDay = retentionDateOnly(row.last_gain_day) ||
        latestDailyDay || retentionManilaDay(lastGainAt);
      const hasGain = !!lastGainDay || Number(row.season_gain || 0) > 0;
      const referenceDay = lastGainDay || seasonStartDay || today;
      const quietDays = retentionDayDiff(referenceDay, today);

      let status;
      if (!hasGain) {
        status = quietDays >= 14 ? 'long_inactive'
          : quietDays >= 7 ? 'inactive' : 'not_yet_active';
      } else {
        status = quietDays >= 14 ? 'long_inactive'
          : quietDays >= 7 ? 'inactive'
            : quietDays >= 3 ? 'cooling' : 'active';
      }

      let previousGain = 0, currentGain = 0;
      let previousActiveDays = 0, currentActiveDays = 0;
      const activityDates = new Set();
      for (const item of memberDays) {
        activityDates.add(item.day);
        if (item.day >= previousStart && item.day <= previousEnd) {
          previousGain += item.gain;
          if (item.gain > 0) previousActiveDays++;
        } else if (item.day >= currentStart && item.day <= currentEnd) {
          currentGain += item.gain;
          if (item.gain > 0) currentActiveDays++;
        }
      }

      const chronologicalDays = Array.from(activityDates).sort();
      let returningAfterDays = null;
      if (chronologicalDays.length >= 2 &&
          chronologicalDays[chronologicalDays.length - 1] >= retentionAddDays(today, -6)) {
        const last = chronologicalDays[chronologicalDays.length - 1];
        const prior = chronologicalDays[chronologicalDays.length - 2];
        const gap = retentionDayDiff(prior, last);
        if (gap >= 8) returningAfterDays = gap - 1;
      }

      const activityDrop = trendAvailable && previousGain >= 25 &&
        previousActiveDays >= 2 && currentGain <= previousGain * 0.5;
      const dropPercent = trendAvailable && previousGain > 0
        ? Math.max(0, ((previousGain - currentGain) / previousGain) * 100) : null;

      return {
        member,
        season_gain: Number(row.season_gain || 0),
        gain_events: Number(row.gain_events || 0),
        active_days: Number(row.active_days || 0),
        last_gain_at: lastGainAt,
        last_gain_day: lastGainDay,
        has_gain: hasGain,
        quiet_days: quietDays,
        status,
        returning: returningAfterDays != null,
        returning_after_days: returningAfterDays,
        previous_7d_gain: previousGain,
        current_7d_gain: currentGain,
        previous_7d_active_days: previousActiveDays,
        current_7d_active_days: currentActiveDays,
        activity_drop: !!activityDrop,
        drop_percent: dropPercent,
      };
    });

    const summary = {
      tracked_members: members.length,
      active: members.filter(row => row.status === 'active').length,
      cooling: members.filter(row => row.status === 'cooling').length,
      inactive: members.filter(row => row.status === 'inactive' || row.status === 'long_inactive').length,
      long_inactive: members.filter(row => row.status === 'long_inactive').length,
      not_yet_active: members.filter(row => row.status === 'not_yet_active').length,
      returning: members.filter(row => row.returning).length,
      declining: trendAvailable ? members.filter(row => row.activity_drop).length : null,
    };

    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=30');
    return res.status(200).json({
      generated_at: Date.now(),
      timezone: 'Asia/Manila',
      season: {
        season_number: seasonNumber,
        status: season.status,
        started_at: Number(season.started_at || 0),
        started_day: seasonStartDay,
        ended_at: season.ended_at == null ? null : Number(season.ended_at),
      },
      summary,
      members,
      returning_members: members.filter(row => row.returning)
        .sort((a, b) => b.returning_after_days - a.returning_after_days ||
          b.season_gain - a.season_gain),
      declining_members: trendAvailable
        ? members.filter(row => row.activity_drop)
          .sort((a, b) => Number(b.drop_percent || 0) - Number(a.drop_percent || 0))
        : [],
      coverage: {
        coverage_start: coverageStart,
        coverage_end: coverageEnd,
        tracked_days: coverageDates.length,
        complete_14_day_baseline: coverageComplete,
        note: coverageComplete
          ? 'Daily snapshots cover both complete seven-day comparison windows.'
          : 'Daily trend comparisons remain disabled until each of the 14 calendar days in both complete comparison windows has a saved ranking snapshot.',
      },
      trend: {
        available: trendAvailable,
        comparison: 'two completed seven-day periods; today is excluded',
        previous_start: previousStart,
        previous_end: previousEnd,
        current_start: currentStart,
        current_end: currentEnd,
        decline_threshold_percent: 50,
        minimum_previous_gain: 25,
        minimum_previous_active_days: 2,
      },
      notes: {
        inactivity: 'Quiet days are measured from the last recorded positive reputation gain, or from the season start for members with no recorded gain this season.',
        returning: 'A returning member has a recorded active day after a gap of at least seven calendar days between active days in this season.',
        daily_history: 'No activity is inferred before the saved daily ledger and ranking snapshot coverage. Drop comparisons are enabled only when both complete seven-day windows have confirmed daily coverage.',
        alerts: 'Discord digests are generated only when member statistics are fresh and a member crosses the 7-day or 14-day inactivity threshold. Each member is notified once per season at each threshold.',
      },
    });
  } catch (error) {
    return res.status(502).json({
      error: error && error.message ? error.message : 'member retention is unavailable',
    });
  }
}

export default async function handler(req, res) {
  if (req.query.view === 'retention') return handleMemberRetention(req, res);
  if (req.query.view === 'comparison') return handleSeasonComparison(req, res);
  if (req.query.view === 'analytics') return handleSeasonAnalytics(req,res);
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
