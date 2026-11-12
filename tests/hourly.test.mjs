import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateHourly, clampHours } from '../api/_hourly.js';

const H = 3600e3;
const NOW = Date.UTC(2026, 10, 12, 8, 30); // 08:30 UTC = 16:30 Manila
const cur = Math.floor(NOW / H) * H;

test('clampHours keeps 1..72 and falls back on junk', () => {
  assert.equal(clampHours('12'), 12);
  assert.equal(clampHours('500'), 72);
  for (const bad of [undefined, '', 'abc', '0', '-3', NaN]) assert.equal(clampHours(bad), 24, String(bad));
});

test('buckets are consecutive whole hours ending at the current hour', () => {
  const r = aggregateHourly([], NOW, 3);
  assert.deepEqual(r.starts, [cur - 2 * H, cur - H, cur]);
  assert.deepEqual(r.totals, [0, 0, 0]);
  assert.equal(r.total, 0);
  assert.deepEqual(r.members, []);
});

test('totals gains per hour and per member', () => {
  const rows = [
    { at: cur + 5, member: 'A', gain: 100 },
    { at: cur + 10 * 60e3, member: 'B', gain: 50 },
    { at: cur - H + 1, member: 'A', gain: 20 },
    { at: cur - 2 * H, member: 'A', gain: 5 },
  ];
  const r = aggregateHourly(rows, NOW, 3);
  assert.deepEqual(r.totals, [5, 20, 150]);
  assert.equal(r.total, 175);
  assert.deepEqual(r.members.map(m => [m.name, m.total]), [['A', 125], ['B', 50]]);
  assert.deepEqual(r.members[0].hours, [5, 20, 100]);
});

test('ignores out-of-range, non-positive and malformed rows', () => {
  const rows = [
    { at: cur - 3 * H, member: 'A', gain: 9 },
    { at: cur + H, member: 'A', gain: 9 },
    { at: cur, member: 'A', gain: 0 },
    { at: cur, member: 'A', gain: -4 },
    { at: cur, member: '  ', gain: 4 },
    { at: 'x', member: 'A', gain: 4 },
    null,
    { at: cur, member: 'A', gain: 7 },
  ];
  const r = aggregateHourly(rows, NOW, 3);
  assert.equal(r.total, 7);
});

test('non-array input is treated as empty', () => {
  assert.equal(aggregateHourly(null, NOW, 2).total, 0);
});
