import * as cheerio from 'cheerio';

const SRC = 'https://ninjazenshin.online/clan-ranking';
const { SUPABASE_URL, DISCORD_WEBHOOK_URL, DISCORD_ROLE_ID, DISCORD_BOT_TOKEN, DISCORD_CHANNEL_ID, SITE_URL } = process.env;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const STOP_AFTER = 5 * 60e3;        // no rep drop for this long = stopped bleeding
const STALE = 10 * 60e3;            // if our last check is older than this, don't compare against it
const RESET_GUARD = 10;             // more simultaneous drops than this = season reset, ignore
const RESET_SHARE = 0.5;            // ...or more than this share of all clans dropping at once
const MIN_PARSE_SHARE = 0.5;        // parsed far fewer clans than last time = bad parse, skip the tick
const ESCALATE_AFTER = 30 * 60e3;   // still bleeding after this long = second ping
const TIMEOUT = 8000;
const BOT = DISCORD_BOT_TOKEN && DISCORD_CHANNEL_ID;
const SITE = SITE_URL || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? 'https://' + process.env.VERCEL_PROJECT_PRODUCTION_URL : '');

const sig = () => AbortSignal.timeout(TIMEOUT);
const H = {
  apikey: SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
  'Content-Type': 'application/json',
};
const TABLE = `${SUPABASE_URL}/rest/v1/bleed_state`;
const EVENTS = `${SUPABASE_URL}/rest/v1/bleed_events`;

// escape Discord markdown in scraped clan names
const md = s => String(s).replace(/([\\*_`~|>])/g, '\\$1');

async function fetchClans() {
  const r = await fetch(SRC, { headers: { 'User-Agent': 'Mozilla/5.0 (bleed-site)' }, signal: sig() });
  if (!r.ok) throw new Error('Source HTTP ' + r.status);
  const $ = cheerio.load(await r.text());
  const clans = [];
  $('table tr').each((_, tr) => {
    const td = $(tr).find('td').map((_, c) => $(c).text().trim()).get();
    if (td.length < 5) return;
    const rep = parseInt(td[4].replace(/,/g, ''), 10);
    if (Number.isNaN(rep)) return;
    clans.push({ rank: parseInt(td[0], 10), name: td[1], master: td[2], members: td[3], rep });
  });
  if (!clans.length) throw new Error('No clans parsed');
  return clans;
}

async function getState() {
  const r = await fetch(`${TABLE}?id=eq.1&select=*`, { headers: H, signal: sig() });
  if (!r.ok) throw new Error('Supabase read failed: ' + r.status);
  const row = (await r.json())[0];
  if (!row) throw new Error('bleed_state row missing - run the SQL first');
  return row;
}

// Compare-and-swap on "ver": only one of several simultaneous checks wins
async function saveState(prevVer, next) {
  const r = await fetch(`${TABLE}?id=eq.1&ver=eq.${prevVer}`, {
    method: 'PATCH', headers: { ...H, Prefer: 'return=representation' }, body: JSON.stringify(next), signal: sig(),
  });
  if (!r.ok) throw new Error('Supabase write failed: ' + r.status);
  return (await r.json()).length === 1;
}

// History: one row per finished bleed. Never breaks a tick if the table is missing.
async function logEvents(stopped, endedAt) {
  if (!stopped.length) return;
  try {
    const rows = stopped.map(s => ({ name: s.name, since: s.since, last_drop: s.lastDrop, lost: s.lost, ended_at: endedAt }));
    const r = await fetch(EVENTS, { method: 'POST', headers: H, body: JSON.stringify(rows), signal: sig() });
    if (!r.ok) console.error('bleed_events insert failed', r.status, await r.text());
  } catch (e) { console.error('bleed_events insert error', e); }
}

// ---------- Discord ----------
const bot = (path, method, body) => fetch('https://discord.com/api/v10' + path, {
  method, headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json' },
  body: body && JSON.stringify(body), signal: sig(),
});

// Uses the bot if configured, else the webhook. Only "start"/"escalation" messages ping the role.
async function say(content, ping) {
  const pingRole = process.env.PING_ENABLED === 'true' && ping && DISCORD_ROLE_ID;
  const body = {
    content: (pingRole ? `<@&${DISCORD_ROLE_ID}> ` : '') + content,
    allowed_mentions: pingRole ? { roles: [DISCORD_ROLE_ID] } : { parse: [] },
  };
  let ok = false;
  if (BOT) {
    const r = await bot(`/channels/${DISCORD_CHANNEL_ID}/messages`, 'POST', body);
    ok = r.ok;
    if (!ok) console.error('Bot message failed', r.status, await r.text());
  }
  if (!ok && DISCORD_WEBHOOK_URL) {
    const r = await fetch(DISCORD_WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: sig() });
    if (!r.ok) console.error('Webhook message failed', r.status, await r.text());
  }
}

function panel(bleeding) {
  const e = Object.entries(bleeding).sort((a, b) => a[1].since - b[1].since), n = e.length;
  const list = n
    ? e.map(([name, b]) => `**${md(name)}**\n> 🩸 Bleeding since <t:${Math.floor(b.since / 1000)}:R> · -${b.lost.toLocaleString()} rep`).join('\n\n')
    : '*No clans are bleeding right now.*';
  const buttons = [{ type: 2, style: 2, custom_id: 'bleed_toggle', label: 'Bleed alerts', emoji: { name: '🔔' } }];
  if (SITE) buttons.push({ type: 2, style: 5, label: 'Clan rankings', url: SITE });
  return {
    embeds: [{
      color: 0xc0392b,
      title: n ? `🩸 ${n} clan${n === 1 ? ' is' : 's are'} bleeding` : '🩸 No clans are bleeding',
      description:
        'Want to know the moment a clan starts **bleeding**? This post watches every clan for you.\n\n' +
        '**How to use**\n1. Press 🔔 **Bleed alerts** to get the notification role.\n2. You\'ll be pinged whenever a clan starts bleeding.\n\n' +
        '**Want to stop the pings?**\nPress 🔔 **Bleed alerts** again to remove the role.\n\n' +
        `──────── 🩸 BLEEDING NOW ────────\n\n${list}`,
      footer: { text: 'Live · updates the moment a clan starts or stops bleeding' },
    }],
    components: [{ type: 1, components: buttons }],
  };
}

// Posts the panel once, then edits it only when the bleeding list changes (<t:..:R> times tick by themselves)
async function syncPanel(prev, bleeding, changed) {
  if (!BOT || !('message_id' in prev)) return;       // 'message_id' column missing = skip, never spam
  const body = panel(bleeding);
  if (prev.message_id) {
    if (!changed) return;
    const r = await bot(`/channels/${DISCORD_CHANNEL_ID}/messages/${prev.message_id}`, 'PATCH', body);
    if (r.ok) return;
    if (r.status !== 404) { console.error('Panel edit failed', r.status, await r.text()); return; }  // 404 = deleted, post a new one
  }
  const r = await bot(`/channels/${DISCORD_CHANNEL_ID}/messages`, 'POST', body);
  if (!r.ok) {
    console.error('Panel post failed', r.status, await r.text());
    return;
  }
  const m = await r.json();
  await fetch(`${TABLE}?id=eq.1`, { method: 'PATCH', headers: H, body: JSON.stringify({ message_id: m.id }), signal: sig() });
}

const dur = ms => { const s = Math.round(ms / 1000); return s < 60 ? s + 's' : Math.floor(s / 60) + 'm ' + (s % 60) + 's'; };

// Runs a check unless the last one is newer than minAgeMs. Returns the current shared state.
// If the source is unreachable or looks wrong, returns the last good state with stale: true.
export async function runTick(minAgeMs) {
  const prev = await getState();
  if (Date.now() - prev.checked_at < minAgeMs) return prev;

  let clans;
  try { clans = await fetchClans(); }
  catch (e) { console.error('fetchClans failed', e); return { ...prev, stale: true }; }

  const prevCount = Object.keys(prev.last_rep || {}).length;
  if (prevCount && clans.length < prevCount * MIN_PARSE_SHARE) {
    console.error(`Parsed ${clans.length} clans vs ${prevCount} last time, skipping tick`);
    return { ...prev, stale: true };
  }

  const now = Date.now();   // taken after the fetch so timestamps match the data
  const cur = Object.fromEntries(clans.map(c => [c.name, c.rep]));
  const bleeding = { ...prev.bleeding };
  const started = [], stopped = [], escalated = [];
  let grew = false;

  const hasBaseline = Object.keys(prev.last_rep || {}).length && now - prev.checked_at < STALE;
  if (hasBaseline) {
    const drops = clans.filter(c => prev.last_rep[c.name] !== undefined && c.rep < prev.last_rep[c.name]);
    if (drops.length <= RESET_GUARD && drops.length <= clans.length * RESET_SHARE) for (const c of drops) {
      const lost = prev.last_rep[c.name] - c.rep, b = bleeding[c.name];
      if (b) { b.lastDrop = now; b.lost += lost; grew = true; }
      else { bleeding[c.name] = { since: now, lastDrop: now, lost }; started.push({ name: c.name, lost }); }
    }
  }
  for (const [n, b] of Object.entries(bleeding)) {
    if (!(n in cur) || now - b.lastDrop > STOP_AFTER) { stopped.push({ name: n, ...b }); delete bleeding[n]; }
    else if (!b.escalated && now - b.since > ESCALATE_AFTER) { b.escalated = true; escalated.push({ name: n, ...b }); }
  }

  const next = { ver: Number(prev.ver) + 1, checked_at: now, last_rep: cur, bleeding, clans };
  if (!(await saveState(prev.ver, next))) return getState();   // another check got there first

  await logEvents(stopped, now);
  try {
    if (started.length) await say(started.map(s => `🩸 **${md(s.name)}** started bleeding (-${s.lost.toLocaleString()} rep)`).join('\n'), true);
    if (escalated.length) await say(escalated.map(s => `🚨 **${md(s.name)}** is still bleeding after ${dur(now - s.since)} (-${s.lost.toLocaleString()} rep so far)`).join('\n'), true);
    if (stopped.length) await say(stopped.map(s => {
      const span = s.lastDrop - s.since;
      return `✅ **${md(s.name)}** stopped bleeding${span >= 1000 ? ` after ${dur(span)}` : ''} (-${s.lost.toLocaleString()} rep total)`;
    }).join('\n'), false);
    await syncPanel(prev, bleeding, started.length + stopped.length > 0 || grew);
  } catch (e) { console.error('Discord step failed', e); }
  return { ...next, message_id: prev.message_id };
}
