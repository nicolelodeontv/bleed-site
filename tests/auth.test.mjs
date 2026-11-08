import test from 'node:test';
import assert from 'node:assert/strict';
import { getCredential, isAuthorized } from '../api/_auth.js';

const req = (query = {}, headers = {}) => ({ query, headers });

test('never authorizes when no secret is configured', () => {
  assert.equal(isAuthorized(req({ key: 'anything' }), undefined), false);
  assert.equal(isAuthorized(req({ key: '' }), ''), false);
  assert.equal(isAuthorized(req({}, { authorization: 'Bearer ' }), ''), false);
});

test('accepts the secret as a bearer token or a query key', () => {
  assert.equal(isAuthorized(req({}, { authorization: 'Bearer s3cret' }), 's3cret'), true);
  assert.equal(isAuthorized(req({}, { authorization: 'bearer s3cret' }), 's3cret'), true);
  assert.equal(isAuthorized(req({ key: 's3cret' }), 's3cret'), true);
});

test('rejects wrong, missing and non-string credentials', () => {
  assert.equal(isAuthorized(req({ key: 'nope' }), 's3cret'), false);
  assert.equal(isAuthorized(req({}), 's3cret'), false);
  assert.equal(isAuthorized(req({ key: ['s3cret', 'x'] }), 's3cret'), false);
  assert.equal(isAuthorized(req({}, { authorization: 'Basic s3cret' }), 's3cret'), false);
  assert.equal(isAuthorized(req({ key: 's3cret ' }), 's3cret'), false);
});

test('prefers the bearer token over the query key', () => {
  assert.equal(getCredential(req({ key: 'q' }, { authorization: 'Bearer h' })), 'h');
  assert.equal(getCredential(req({ key: 'q' })), 'q');
  assert.equal(getCredential(req()), '');
});
