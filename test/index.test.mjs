import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isNewer, parseVersion } from '../lib/index.js';

test('parseVersion 只接受 x.y.z 开头', () => {
  assert.deepEqual(parseVersion('0.1.0'), [0, 1, 0]);
  assert.deepEqual(parseVersion('1.2.3-beta.1'), [1, 2, 3]);
  assert.equal(parseVersion('v1.2.3'), null);
  assert.equal(parseVersion('1.2'), null);
  assert.equal(parseVersion(''), null);
  assert.equal(parseVersion(undefined), null);
});

test('isNewer 逐段比较，不乱排序', () => {
  assert.equal(isNewer('0.1.1', '0.1.0'), true);
  assert.equal(isNewer('0.2.0', '0.1.9'), true);
  assert.equal(isNewer('1.10.0', '1.9.0'), true);
  assert.equal(isNewer('0.1.0', '0.1.0'), false);
  assert.equal(isNewer('0.1.0', '0.1.1'), false);
  assert.equal(isNewer('2.0.0', '1.99.99'), true);
});

test('isNewer 遇到无法解析的输入一律不算更新', () => {
  assert.equal(isNewer('latest', '0.1.0'), false);
  assert.equal(isNewer('0.1.1', 'unknown'), false);
  assert.equal(isNewer(null, '0.1.0'), false);
});
