import test from 'node:test';
import assert from 'node:assert/strict';
import { ESCALATE_AFTER, RESET_GUARD, STALE, STOP_AFTER, evaluateBleeding } from '../api/_bleed.js';

const NOW = 1_800_000_000_000;
const clan = (name, rep) => ({ name, rep });
const prevState = (over = {}) => ({
  bleeding: {},
  last_rep: { A: 1000, B: 900, C: 800, D: 700, E: 600 },
  checked_at: NOW - 30_000,
  ...over,
});
const ranking = (reps) => Object.entries(reps).map(([name, rep]) => clan(name, rep));

test('a clan whose reputation drops starts bleeding', () => {
  const r = evaluateBleeding(prevState(), ranking({ A: 950, B: 900, C: 800, D: 700, E: 600 }), NOW);
  assert.deepEqual(r.started, [{ name: 'A', lost: 50 }]);
  assert.deepEqual(r.bleeding.A, { since: NOW, lastDrop: NOW, lost: 50 });
});

test('further drops add to the loss without starting again', () => {
  const prev = prevState({ bleeding: { A: { since: NOW - 60_000, lastDrop: NOW - 30_000, lost: 50 } }, last_rep: { A: 950, B: 900, C: 800, D: 700, E: 600 } });
  const r = evaluateBleeding(prev, ranking({ A: 940, B: 900, C: 800, D: 700, E: 600 }), NOW);
  assert.equal(r.started.length, 0);
  assert.equal(r.bleeding.A.lost, 60);
  assert.equal(r.bleeding.A.lastDrop, NOW);
  assert.equal(r.grew, true);
});

test('bleeding stops after the quiet period', () => {
  const prev = prevState({ bleeding: { A: { since: NOW - 10 * 60e3, lastDrop: NOW - STOP_AFTER - 1, lost: 80 } } });
  const r = evaluateBleeding(prev, ranking({ A: 1000, B: 900, C: 800, D: 700, E: 600 }), NOW);
  assert.equal(r.stopped.length, 1);
  assert.equal(r.stopped[0].name, 'A');
  assert.equal('A' in r.bleeding, false);
});

test('a clan that disappears from the ranking stops bleeding', () => {
  const prev = prevState({ bleeding: { A: { since: NOW - 1000, lastDrop: NOW - 1000, lost: 10 } } });
  const r = evaluateBleeding(prev, ranking({ B: 900, C: 800, D: 700, E: 600 }), NOW);
  assert.equal(r.stopped.length, 1);
});

test('a long bleed escalates once', () => {
  const prev = prevState({ bleeding: { A: { since: NOW - ESCALATE_AFTER - 1, lastDrop: NOW - 1000, lost: 200 } } });
  const same = ranking({ A: 1000, B: 900, C: 800, D: 700, E: 600 });
  const first = evaluateBleeding(prev, same, NOW);
  assert.equal(first.escalated.length, 1);
  assert.equal(first.bleeding.A.escalated, true);
  const second = evaluateBleeding({ ...prev, bleeding: first.bleeding }, same, NOW + 1000);
  assert.equal(second.escalated.length, 0);
});

test('a mass drop is treated as a season reset and ignored', () => {
  const names = Array.from({ length: RESET_GUARD + 5 }, (_, i) => 'C' + i);
  const last_rep = Object.fromEntries(names.map(n => [n, 1000]));
  const clans = names.map(n => clan(n, 10));
  const r = evaluateBleeding(prevState({ last_rep }), clans, NOW);
  assert.equal(r.started.length, 0);
  assert.deepEqual(r.bleeding, {});
});

test('half of all clans dropping at once is treated as a reset', () => {
  const r = evaluateBleeding(prevState(), ranking({ A: 1, B: 1, C: 1, D: 700, E: 600 }), NOW);
  assert.equal(r.started.length, 0);
});

test('a stale or missing baseline never creates bleeding', () => {
  const lower = ranking({ A: 500, B: 900, C: 800, D: 700, E: 600 });
  assert.equal(evaluateBleeding(prevState({ checked_at: NOW - STALE - 1 }), lower, NOW).started.length, 0);
  assert.equal(evaluateBleeding(prevState({ last_rep: {} }), lower, NOW).started.length, 0);
});

test('new clans and rising reputation are not bleeding', () => {
  const r = evaluateBleeding(prevState(), ranking({ A: 1100, B: 900, C: 800, D: 700, E: 600, F: 50 }), NOW);
  assert.equal(r.started.length, 0);
  assert.equal(r.cur.F, 50);
});

test('does not mutate the previous state', () => {
  const prev = prevState({ bleeding: { A: { since: NOW - 1000, lastDrop: NOW - 1000, lost: 10 } } });
  const before = JSON.stringify(prev);
  evaluateBleeding(prev, ranking({ A: 900, B: 900, C: 800, D: 700, E: 600 }), NOW);
  // bleeding entries are shared objects by design; the map and last_rep must be untouched
  assert.deepEqual(prev.last_rep, JSON.parse(before).last_rep);
  assert.deepEqual(Object.keys(prev.bleeding), ['A']);
});
