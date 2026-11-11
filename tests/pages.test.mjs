import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const pages = fs.readdirSync(root).filter((f) => f.endsWith('.html'));
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

test('there are pages to check', () => assert.ok(pages.length > 0));

for (const page of pages) {
  const html = read(page);

  test(`${page}: inline scripts parse`, () => {
    const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    for (const code of blocks) assert.doesNotThrow(() => new vm.Script(code, { filename: page }));
  });

  test(`${page}: local links and scripts point at real files`, () => {
    for (const m of html.matchAll(/(?:href|src)="([^"#?]+)(?:[?#][^"]*)?"/g)) {
      const target = m[1];
      if (/^(https?:|mailto:|data:|tel:|javascript:|\/\/)/.test(target)) continue;
      const clean = target.replace(/^\//, '');
      if (!clean || clean.startsWith('api/')) continue;
      assert.ok(fs.existsSync(path.join(root, clean)), `${page} references missing file ${target}`);
    }
  });

  test(`${page}: <head> has no stray visible text`, () => {
    const head = html.split(/<\/head>/i)[0]
      .replace(/<(style|script|title)[\s\S]*?<\/\1>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<[^>]*>/g, '');
    assert.equal(head.replace(/\s+/g, '').replace(/^<!doctype.*$/i, ''), '', `${page} has leftover text in <head>: ${head.trim().slice(0, 40)}`);
  });

  test(`${page}: calls only API routes that exist`, () => {
    for (const m of html.matchAll(/fetch\(\s*[`'"]\/?(api\/[a-z-]+)/g)) {
      assert.ok(fs.existsSync(path.join(root, m[1] + '.js')), `${page} calls missing route ${m[1]}`);
    }
  });
}

test('manifest icons exist and are not both "any maskable"', () => {
  const manifest = JSON.parse(read('manifest.webmanifest'));
  for (const icon of manifest.icons) {
    assert.ok(fs.existsSync(path.join(root, icon.src.replace(/^\//, ''))), icon.src);
    assert.notEqual(icon.purpose, 'any maskable');
  }
});
