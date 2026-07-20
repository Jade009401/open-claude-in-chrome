'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
require('./load-extension-globals');
const core = globalThis.ClaudeUniversalBrowserMapCore;
const n = (s) => core.extractLeadingNumber(s);

test('时间戳不算序号(:​不是序号分隔符)', () => {
  for (const s of ['16:03:39', '20:36:42', '17:38:22', '22:11:06', '9:05']) assert.strictEqual(n(s), null, s);
});

test('小数/价格不算序号(数字后紧跟 .数字 = 小数)', () => {
  for (const s of ['20.070', '23.070', '0.00002350', '1.5']) assert.strictEqual(n(s), null, s);
});

test('千分位不算序号(回归)', () => {
  for (const s of ['2,000.00', '64,848.16']) assert.strictEqual(n(s), null, s);
});

test('正经序号仍识别(回归)', () => {
  assert.strictEqual(n('1.'), 1);
  assert.strictEqual(n('1) 标题'), 1);
  assert.strictEqual(n('(3) 标题'), 3);
  assert.strictEqual(n('3）标题'), 3);
  assert.strictEqual(n('第1条'), 1);
  assert.strictEqual(n('1、项'), 1);
  assert.strictEqual(n('16'), 16);
  assert.strictEqual(n('3 条'), 3);
});
