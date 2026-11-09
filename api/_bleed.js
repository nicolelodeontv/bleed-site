// Pure bleed-detection rules (no network, no environment) so they can be unit tested.

export const STOP_AFTER = 5 * 60e3;        // no rep drop for this long = stopped bleeding
export const STALE = 10 * 60e3;            // if our last check is older than this, don't compare against it
export const RESET_GUARD = 10;             // more simultaneous drops than this = season reset, ignore
export const RESET_SHARE = 0.5;            // ...or more than this share of all clans dropping at once
export const MIN_PARSE_SHARE = 0.5;        // parsed far fewer clans than last time = bad parse, skip the tick
export const ESCALATE_AFTER = 30 * 60e3;   // still bleeding after this long = second ping

// Compares the fresh ranking with the previous state and returns the new bleeding map plus
// which clans started, stopped or escalated. `prev` is the stored state row.
export function evaluateBleeding(prev, clans, now) {
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
  return { cur, bleeding, started, stopped, escalated, grew };
}
