import * as cheerio from 'cheerio';

const SRC = 'https://ninjazenshin.online/clan-ranking';
const { SUPABASE_URL, SUPABASE_SERVICE_KEY, DISCORD_WEBHOOK_URL, DISCORD_ROLE_ID } = process.env;
const STOP_AFTER = 5 * 60e3;   // no rep drop for this long = stopped bleeding
const STALE = 10 * 60e3;       // if our last check is older than this, don't compare against it
const RESET_GUARD = 10;        // more simultaneous drops than this = season reset, ignore

const H = {
  apikey: SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
  'Content-Type': 'application/json',
};
const TABLE = `${SUPABASE_URL}/rest/v1/bleed_state`;

async function fetchClans() {
  const r = await fetch(SRC, { headers: { 'User-Agent': 'Mozilla/5.0 (bleed-site)' } });
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
  const r = await fetch(`${TABLE}?id=eq.1&select=*`, { headers: H });
  if (!r.ok) throw new Error('Supabase read failed: ' + r.status);
  const row = (await r.json())[0];
  if (!row) throw new Error('bleed_state row missing - run the SQL first');
  return row;
}

// Compare-and-swap on "ver": only one of several simultaneous checks wins
async function saveState(prevVer, next) {
  const r = await fetch(`${TABLE}?id=eq.1&ver=eq.${prevVer}`, {
    method: 'PATCH', headers: { ...H, Prefer: 'return=representation' }, body: JSON.stringify(next),
  });
  if (!r.ok) throw new Error('Supabase write failed: ' + r.status);
  return (await r.json()).length === 1;
}

async function notify(started) {
  if (!DISCORD_WEBHOOK_URL) return;
  const ping = DISCORD_ROLE_ID ? `<@&${DISCORD_ROLE_ID}> ` : '';
  const lines = started.map(s => `🩸 **${s.name}** started bleeding (-${s.lost.toLocaleString()} rep)`).join('\n');
  await fetch(DISCORD_WEBHOOK_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: ping + lines, allowed_mentions: DISCORD_ROLE_ID ? { roles: [DISCORD_ROLE_ID] } : { parse: [] } }),
  }).catch(() => {});
}

// Runs a check unless the last one is newer than minAgeMs. Returns the current shared state.
export async function runTick(minAgeMs) {
  const prev = await getState();
  const now = Date.now();
  if (now - prev.checked_at < minAgeMs) return prev;

  const clans = await fetchClans();
  const cur = Object.fromEntries(clans.map(c => [c.name, c.rep]));
  const bleeding = { ...prev.bleeding };
  const started = [];

  const hasBaseline = Object.keys(prev.last_rep || {}).length && now - prev.checked_at < STALE;
  if (hasBaseline) {
    const drops = clans.filter(c => prev.last_rep[c.name] !== undefined && c.rep < prev.last_rep[c.name]);
    if (drops.length <= RESET_GUARD) for (const c of drops) {
      const lost = prev.last_rep[c.name] - c.rep, b = bleeding[c.name];
      if (b) { b.lastDrop = now; b.lost += lost; }
      else { bleeding[c.name] = { since: now, lastDrop: now, lost }; started.push({ name: c.name, lost }); }
    }
  }
  for (const [n, b] of Object.entries(bleeding)) if (!cur[n] || now - b.lastDrop > STOP_AFTER) delete bleeding[n];

  const next = { ver: Number(prev.ver) + 1, checked_at: now, last_rep: cur, bleeding, clans };
  if (!(await saveState(prev.ver, next))) return getState();   // another check got there first
  if (started.length) await notify(started);
  return next;
}
