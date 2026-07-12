const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolvePrice, PRICING } = require('../lib/pricing');

test('trial lessons are always free regardless of level', () => {
  assert.equal(resolvePrice('trial', 'alevel'), PRICING.trial);
  assert.equal(resolvePrice('trial', 'gcse'), PRICING.trial);
  assert.equal(resolvePrice('trial', undefined), PRICING.trial);
});

test('group sessions resolve regardless of level', () => {
  assert.equal(resolvePrice('group', 'gcse'), PRICING.group);
});

test('alevel resolves to the alevel price', () => {
  assert.equal(resolvePrice('gcse', 'alevel'), PRICING.alevel);
  assert.equal(resolvePrice(undefined, 'alevel'), PRICING.alevel);
});

test('defaults to gcse pricing for anything else', () => {
  assert.equal(resolvePrice('gcse', 'gcse'), PRICING.gcse);
  assert.equal(resolvePrice(undefined, undefined), PRICING.gcse);
  assert.equal(resolvePrice('bogus', 'bogus'), PRICING.gcse);
});
