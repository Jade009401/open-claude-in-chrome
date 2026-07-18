'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { core, kernel, bmap } = require('./load-extension-globals');

test('三个全局都加载成功', () => {
  assert.ok(core && typeof core.hashString === 'function', 'core.hashString');
  assert.ok(kernel && typeof kernel.compileEvidenceBatches === 'function', 'kernel.compileEvidenceBatches');
  assert.ok(bmap && typeof bmap.scan === 'function', 'bmap.scan');
});
