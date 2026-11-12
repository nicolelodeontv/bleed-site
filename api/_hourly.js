// Pure helper: totals Chaos rep gains per hour, overall and per member.
// Hour buckets are aligned to UTC hours, which are also whole Asia/Manila hours (UTC+8, no DST),
// so the browser can label them in Manila time with Intl.
const HOUR = 3600e3;

export function clampHours(value, fallback = 24, max = 72) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, max);
}

export function aggregateHourly(rows, nowMs, hours) {
  const last = Math.floor(nowMs / HOUR) * HOUR;
  const first = last - (hours - 1) * HOUR;
  const starts = Array.from({ length: hours }, (_, i) => first + i * HOUR);
  const totals = new Array(hours).fill(0);
  const byMember = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const at = Number(row && row.at), gain = Number(row && row.gain);
    const name = row && typeof row.member === 'string' ? row.member.trim() : '';
    if (!Number.isFinite(at) || !Number.isFinite(gain) || gain <= 0 || !name) continue;
    const idx = Math.floor((at - first) / HOUR);
    if (idx < 0 || idx >= hours) continue;
    totals[idx] += gain;
    let m = byMember.get(name);
    if (!m) { m = { name, total: 0, hours: new Array(hours).fill(0) }; byMember.set(name, m); }
    m.hours[idx] += gain;
    m.total += gain;
  }
  const members = [...byMember.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  return { starts, totals, total: totals.reduce((s, v) => s + v, 0), members };
}
