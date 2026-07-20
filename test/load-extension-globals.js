'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load(rel) {
  const file = path.join(__dirname, '..', 'extension', rel);
  const code = fs.readFileSync(file, 'utf8');
  vm.runInThisContext(code, { filename: rel }); // IIFE attaches to globalThis
}

// 顺序有依赖:core → kernel → browser-map
load('universal-browser-map-core.js');
load('universal-map-kernel.js');
load('universal-browser-map.js');

module.exports = {
  core: globalThis.ClaudeUniversalBrowserMapCore,
  kernel: globalThis.ClaudeUniversalMapKernel,
  bmap: globalThis.ClaudeUniversalBrowserMap,
};
