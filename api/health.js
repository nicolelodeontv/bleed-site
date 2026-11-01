// api/health.js - checks every server-side part of Bleed Watch.
// Returns only yes/no, ages and counts. It never returns a secret value.

const { SUPABASE_URL, CRON_SECRET, DISCORD_BOT_TOKEN, DISCORD_CHANNEL_ID, DISCORD_ROLE_ID, DISCORD_PUBLIC_KEY, PING_ENABLED } = process.env;
const KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };
const REST = `${SUPABASE_URL}/rest/v1`;
const UA = { 'User-Agent': 'Mozilla/5.0 (bleed-site)' };

const ago = ms => (ms < 60e3 ? Math.round(ms / 1000) + 's' : ms < 3600e3 ? Math.round(ms / 60e3) + 'm' : Math.round(ms / 3600e3) + 'h');
async function timed(fn) {
  const t = Date.now();
  try { return { ...(await fn()), ms: Date.now() - t }; }
  catch (e) { return { ok: false, detail: e.message, ms: Date.now() - t }; }
}

export default async function handler(req, res) {
  const checks = [];
  const add = (name, r) => checks.push({ name, ...r });
  const now = Date.now();

  // 1. Environment variables (yes/no only)
  const required = { SUPABASE_URL: !!SUPABASE_URL, 'Supabase service key': !!KEY, CRON_SECRET: !!CRON_SECRET };
  const optional = { DISCORD_BOT_TOKEN: !!DISCORD_BOT_TOKEN, DISCORD_CHANNEL_ID: !!DISCORD_CHANNEL_ID, DISCORD_ROLE_ID: !!DISCORD_ROLE_ID, DISCORD_PUBLIC_KEY: !!DISCORD_PUBLIC_KEY };
  const missReq = Object.keys(required).filter(k => !required[k]);
  const missOpt = Object.keys(optional).filter(k => !optional[k]);
  add('Environment variables', {
    ok: !missReq.length,
    warn: !missReq.length && missOpt.length > 0,
    detail: missReq.length ? 'missing: ' + missReq.join(', ') : missOpt.length ? 'required set; Discord not set: ' + missOpt.join(', ') : 'all set',
  });

  // 2. Database and the shared state row
  let state = null;
  add('Database: bleed_state', await timed(async () => {
    const r = await fetch(`${REST}/bleed_state?id=eq.1&select=*`, { headers: H });
    if (!r.ok) return { ok: false, detail: 'HTTP ' + r.status + ' (wrong URL or key?)' };
    state = (await r.json())[0];
    return state ? { ok: true, detail: 'row found' } : { ok: false, detail: 'row missing - run supabase.sql' };
  }));

  if (state) {
    const age = now - Number(state.checked_at || 0);
    add('Ranking check is fresh', { ok: age < 120e3, detail: 'last check ' + ago(age) + ' ago' });

    if (state.members_checked_at === undefined) {
      add('Members check is fresh', { ok: true, warn: true, detail: 'optional column members_checked_at not added' });
    } else {
      const a = now - Number(state.members_checked_at || 0);
      add('Members check is fresh', { ok: a < 180e3, detail: Number(state.members_checked_at) ? 'last check ' + ago(a) + ' ago' : 'never recorded yet' });
    }

    add('Discord panel message', {
      ok: true, warn: !state.message_id && !!DISCORD_BOT_TOKEN,
      detail: state.message_id ? 'saved' : DISCORD_BOT_TOKEN ? 'not posted yet' : 'bot not configured',
    });
  }

  // 3. Member tracking tables
  for (const t of ['member_rep', 'rep_gains']) {
    add('Table: ' + t, await timed(async () => {
      const r = await fetch(`${REST}/${t}?select=*&limit=1`, { headers: { ...H, Prefer: 'count=exact' } });
      if (!r.ok) return { ok: false, detail: 'HTTP ' + r.status + ' - run members.sql' };
      return { ok: true, detail: ((r.headers.get('content-range') || '').split('/')[1] || '?') + ' rows' };
    }));
  }
  add('Latest recorded win', await timed(async () => {
    const r = await fetch(`${REST}/rep_gains?select=at,clan,member,gain&order=at.desc&limit=1`, { headers: H });
    if (!r.ok) return { ok: false, detail: 'HTTP ' + r.status };
    const w = (await r.json())[0];
    return { ok: true, detail: w ? w.member + ' (' + w.clan + ') +' + w.gain + ', ' + ago(now - Number(w.at)) + ' ago' : 'none yet' };
  }));

  // 4. The game site
  add('Game site: Chaos members list', await timed(async () => {
    const r = await fetch('https://ninjazenshin.online/clan-ranking/members/3', { headers: UA });
    if (!r.ok) return { ok: false, detail: 'HTTP ' + r.status };
    const d = await r.json();
    const n = (d.members || []).length;
    return { ok: n > 0, detail: n + ' members, clan rep ' + d.reputation };
  }));
  add('Game site: clan ranking page', await timed(async () => {
    const r = await fetch('https://ninjazenshin.online/clan-ranking', { headers: UA });
    if (!r.ok) return { ok: false, detail: 'HTTP ' + r.status };
    const n = ((await r.text()).match(/data-clan=/g) || []).length;
    return { ok: n > 0, detail: n + ' clans found' + (n ? '' : ' - the page layout may have changed') };
  }));

  // 5. Discord
  if (DISCORD_BOT_TOKEN && DISCORD_CHANNEL_ID) {
    add('Discord bot can see the channel', await timed(async () => {
      const r = await fetch('https://discord.com/api/v10/channels/' + DISCORD_CHANNEL_ID, { headers: { Authorization: 'Bot ' + DISCORD_BOT_TOKEN } });
      return r.ok ? { ok: true, detail: 'HTTP 200' } : { ok: false, detail: 'HTTP ' + r.status + (r.status === 403 ? ' - bot cannot see the channel' : r.status === 401 ? ' - bad bot token' : '') };
    }));
  }
  add('Role pings', { ok: true, detail: PING_ENABLED === 'true' ? 'on' : 'off (PING_ENABLED is not "true")' });

  res.setHeader('Cache-Control', 's-maxage=20, stale-while-revalidate=40');
  res.status(200).json({ ok: checks.every(c => c.ok), at: now, checks });
}
