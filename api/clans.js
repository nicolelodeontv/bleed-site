import * as cheerio from 'cheerio';
import { ensureDailyClanSnapshot } from './_lib.js';

const SRC = 'https://ninjazenshin.online/clan-ranking';
const SUPABASE_URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY };

function shiftDate(date, days) {
  const value = new Date(date + 'T00:00:00.000Z');
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function number(value) {
  const result = Number(value);
  return Number.isFinite(result) ? result : 0;
}

async function handleHistory(res) {
  if (!SUPABASE_URL || !KEY) {
    return res.status(503).json({ error: 'Clan history storage is not configured.' });
  }

  const capture = await ensureDailyClanSnapshot();
  const since = shiftDate(capture.snapshot_date, -30);
  const params = new URLSearchParams({
    select: 'snapshot_date,clan_name,rank_position,master_name,member_count,member_capacity,reputation,captured_at',
    snapshot_date: 'gte.' + since,
    order: 'snapshot_date.asc,rank_position.asc',
    limit: '5000',
  });
  const response = await fetch(SUPABASE_URL + '/rest/v1/clan_ranking_daily?' + params.toString(), {
    headers: H,
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error('Clan history read failed: ' + response.status);
  const rows = await response.json();

  const dates = Array.from(new Set(rows.map(row => String(row.snapshot_date).slice(0, 10)))).sort();
  const latestDate = dates.length ? dates[dates.length - 1] : null;
  const weekDate = latestDate ? shiftDate(latestDate, -7) : null;
  const monthDate = latestDate ? shiftDate(latestDate, -30) : null;
  const dateSet = new Set(dates);
  let consecutiveDays = 0;
  if (latestDate) {
    let cursor = latestDate;
    while (dateSet.has(cursor)) {
      consecutiveDays++;
      cursor = shiftDate(cursor, -1);
    }
  }

  const byDate = new Map();
  const historyByClan = new Map();
  for (const row of rows) {
    const date = String(row.snapshot_date).slice(0, 10);
    if (!byDate.has(date)) byDate.set(date, new Map());
    const item = {
      date,
      name: row.clan_name,
      rank: number(row.rank_position),
      master: row.master_name || '',
      members: number(row.member_count),
      capacity: number(row.member_capacity),
      rep: number(row.reputation),
      captured_at: number(row.captured_at),
    };
    byDate.get(date).set(row.clan_name, item);
    if (!historyByClan.has(row.clan_name)) historyByClan.set(row.clan_name, []);
    historyByClan.get(row.clan_name).push(item);
  }

  const currentRows = latestDate && byDate.has(latestDate)
    ? Array.from(byDate.get(latestDate).values()).sort((a, b) => a.rank - b.rank)
    : [];
  const weekRows = weekDate && byDate.has(weekDate) ? byDate.get(weekDate) : null;
  const monthRows = monthDate && byDate.has(monthDate) ? byDate.get(monthDate) : null;

  const clans = currentRows.map(current => {
    const week = weekRows && weekRows.get(current.name);
    const month = monthRows && monthRows.get(current.name);
    const history = (historyByClan.get(current.name) || []).map(item => ({
      date: item.date, rank: item.rank, rep: item.rep, members: item.members, capacity: item.capacity,
    }));
    return {
      name: current.name,
      master: current.master,
      rank: current.rank,
      members: current.members,
      capacity: current.capacity,
      rep: current.rep,
      rep_gain_7d: week ? current.rep - week.rep : null,
      rank_change_7d: week ? week.rank - current.rank : null,
      member_change_7d: week ? current.members - week.members : null,
      rep_gain_30d: month ? current.rep - month.rep : null,
      rank_change_30d: month ? month.rank - current.rank : null,
      history,
    };
  });

  const weekly = clans.filter(clan => clan.rep_gain_7d !== null);
  const monthly = clans.filter(clan => clan.rep_gain_30d !== null);
  const topGainer = weekly.slice().sort((a, b) => b.rep_gain_7d - a.rep_gain_7d)[0] || null;
  const topRiser = weekly.slice().sort((a, b) => b.rank_change_7d - a.rank_change_7d)[0] || null;

  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=60');
  return res.status(200).json({
    generated_at: Date.now(),
    timezone: 'Asia/Manila',
    coverage: {
      snapshot_dates: dates.length,
      consecutive_snapshot_days: consecutiveDays,
      latest_snapshot_date: latestDate,
      first_snapshot_date: dates[0] || null,
      required_weekly_days: 8,
      weekly_baseline_date: weekRows ? weekDate : null,
      monthly_baseline_date: monthRows ? monthDate : null,
      weekly_comparison_ready: weekly.length > 0,
      monthly_comparison_ready: monthly.length > 0,
      weekly_compared_clans: weekly.length,
      monthly_compared_clans: monthly.length,
      current_clans: currentRows.length,
      snapshot_note: latestDate
        ? 'Daily rankings are captured once per Manila calendar day. Comparisons appear only when the exact baseline date exists.'
        : 'No daily clan ranking snapshots have been captured yet.',
    },
    summary: {
      clan_count: currentRows.length,
      total_reputation: currentRows.reduce((sum, clan) => sum + clan.rep, 0),
      weekly_rep_change: weekly.length ? weekly.reduce((sum, clan) => sum + clan.rep_gain_7d, 0) : null,
      monthly_rep_change: monthly.length ? monthly.reduce((sum, clan) => sum + clan.rep_gain_30d, 0) : null,
      top_gainer: topGainer ? { name: topGainer.name, value: topGainer.rep_gain_7d } : null,
      top_riser: topRiser ? { name: topRiser.name, value: topRiser.rank_change_7d } : null,
    },
    clans,
  });
}

export default async function handler(req, res) {
  if (req.query && req.query.view === 'history') {
    try {
      return await handleHistory(res);
    } catch (error) {
      console.error('Clan history API failed:', error);
      return res.status(502).json({ error: error && error.message ? error.message : 'Clan history unavailable.' });
    }
  }

  try {
    const r = await fetch(SRC, { headers: { 'User-Agent': 'Mozilla/5.0 (bleed-site)' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const $ = cheerio.load(await r.text());

    const clans = [];
    $('table tr').each((_, tr) => {
      const td = $(tr).find('td').map((_, c) => $(c).text().trim()).get();
      if (td.length < 5) return;
      const rep = parseInt(td[4].replace(/,/g, ''), 10);
      if (Number.isNaN(rep)) return;
      clans.push({ rank: parseInt(td[0], 10), name: td[1], master: td[2], members: td[3], rep });
    });
    if (!clans.length) throw new Error('No clans parsed - table selector may need adjusting');

    res.setHeader('Cache-Control', 's-maxage=10, stale-while-revalidate=20');
    res.status(200).json({ updated: Date.now(), clans });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
}
