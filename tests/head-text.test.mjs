import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const pages = fs.readdirSync(root).filter((file) => file.endsWith('.html'));

for (const page of pages) {
  test(`${page}: <head> has no stray visible text`, () => {
    const html = fs.readFileSync(path.join(root, page), 'utf8');
    const head = html.split(/<\\/head>/i)[0]
      .replace(/<(style|script|title)[\\s\\S]*?<\\/\\1>/gi, '')
      .replace(/<!--[\\s\\S]*?-->/g, '')
      .replace(/<[^>]*>/g, '');

    assert.equal(
      head.replace(/\\s+/g, ''),
      '',
      `${page} has leftover text in <head>: ${head.trim().slice(0, 40)}`
    );
  });
}
