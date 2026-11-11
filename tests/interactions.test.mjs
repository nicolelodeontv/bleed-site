import test from 'node:test';
import assert from 'node:assert/strict';
import { isFreshTimestamp } from '../api/interactions.js';

const NOW = 1_800_000_000_000;
const sec = (offset) => String(NOW / 1000 + offset);

test('accepts timestamps close to now', () => {
  assert.equal(isFreshTimestamp(sec(0), NOW), true);
  assert.equal(isFreshTimestamp(sec(-299), NOW), true);
  assert.equal(isFreshTimestamp(sec(299), NOW), true);
});

test('rejects stale or far-future timestamps (replay protection)', () => {
  assert.equal(isFreshTimestamp(sec(-301), NOW), false);
  assert.equal(isFreshTimestamp(sec(301), NOW), false);
});

test('rejects missing or malformed timestamps', () => {
  for (const bad of [undefined, null, '', 'abc', '0', '-5', NaN]) {
    assert.equal(isFreshTimestamp(bad, NOW), false, String(bad));
  }
});
