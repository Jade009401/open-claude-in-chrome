// readDesign 缓存 + figmaFetch 429 退避(mock 全局 fetch,不打真接口)。
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.FIGMA_TOKEN = 'test-token'; // 惰性 token,env 覆盖 → assertFigmaToken 通过
const { readDesign } = await import('../figma-client.mjs');

function nodesResponse() {
  return {
    ok: true, status: 200, headers: { get: () => null },
    json: async () => ({ nodes: { '1:2': { document: { type: 'FRAME', name: 'root', absoluteBoundingBox: { x: 0, y: 0, width: 10, height: 10 } }, components: {} } } }),
    text: async () => '',
  };
}

test('readDesign:同屏第二次走缓存,不再打接口', async () => {
  let calls = 0;
  const orig = globalThis.fetch;
  globalThis.fetch = async () => { calls += 1; return nodesResponse(); };
  try {
    const url = 'https://www.figma.com/design/ABC/x?node-id=1-2';
    await readDesign(url);
    await readDesign(url);
    assert.equal(calls, 1, '第二次命中缓存,不再 fetch');
  } finally { globalThis.fetch = orig; }
});

test('figmaFetch:429 后按 Retry-After 退避重试并成功', async () => {
  let calls = 0;
  const orig = globalThis.fetch;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) return { ok: false, status: 429, headers: { get: (h) => (h === 'retry-after' ? '0.05' : null) }, json: async () => ({}), text: async () => 'rate' };
    return nodesResponse();
  };
  try {
    const r = await readDesign('https://www.figma.com/design/ABC/x?node-id=1-2', { refresh: true });
    assert.ok(r.design, '重试后拿到设计');
    assert.equal(calls, 2, '429 后重试一次成功');
  } finally { globalThis.fetch = orig; }
});
