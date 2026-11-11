import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveClanMembersLink } from '../api/_clan-links.js';

test('accepts the supported relative clan member route', () => {
  assert.deepEqual(
    resolveClanMembersLink('/clan-ranking/members/3'),
    { id: 3, href: 'https://ninjazenshin.online/clan-ranking/members/3' }
  );
});

test('accepts an absolute link on the game site and normalizes a trailing slash', () => {
  assert.deepEqual(
    resolveClanMembersLink('https://ninjazenshin.online/clan-ranking/members/36/'),
    { id: 36, href: 'https://ninjazenshin.online/clan-ranking/members/36/' }
  );
});

test('rejects external hosts and unrelated paths', () => {
  assert.equal(resolveClanMembersLink('https://example.com/clan-ranking/members/3'), null);
  assert.equal(resolveClanMembersLink('/admin/clan-ranking/members/3'), null);
  assert.equal(resolveClanMembersLink('/clan-ranking/members/3/extra'), null);
});

test('rejects invalid ids and non-string values', () => {
  assert.equal(resolveClanMembersLink('/clan-ranking/members/0'), null);
  assert.equal(resolveClanMembersLink('/clan-ranking/members/not-a-number'), null);
  assert.equal(resolveClanMembersLink('/clan-ranking/members/9007199254740992'), null);
  assert.equal(resolveClanMembersLink(''), null);
  assert.equal(resolveClanMembersLink(['3']), null);
  assert.equal(resolveClanMembersLink(null), null);
});
