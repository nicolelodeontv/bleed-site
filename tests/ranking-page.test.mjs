import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';

const html = readFileSync(new URL('../clan-ranking.html', import.meta.url), 'utf8');

test('Clan Ranking inline JavaScript parses without syntax errors', () => {
  const inlineScripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter(([, attributes, code]) => !/\bsrc\s*=/.test(attributes) && code.trim());

  assert.equal(inlineScripts.length, 1, 'expected one inline application script');
  assert.doesNotThrow(() => new Script(inlineScripts[0][2], { filename: 'clan-ranking.html' }));
});

test('Clan Ranking page includes the controls wired by its application script', () => {
  for (const id of [
    'search',
    'activity-filter',
    'page-size',
    'refresh',
    'ranking-rows',
    'previous',
    'next',
    'close-dialog',
    'clan-dialog',
    'season-status',
  ]) {
    assert.match(html, new RegExp('id="' + id + '"'), 'missing #' + id);
  }

  for (const key of ['rank', 'name', 'master', 'members', 'rep']) {
    assert.match(html, new RegExp('data-sort="' + key + '"'), 'missing sort control for ' + key);
  }

  assert.match(html, /\/api\/clans\?view=members&id=/);
  assert.match(html, /href="\/clan-ranking\.html"/);
});
