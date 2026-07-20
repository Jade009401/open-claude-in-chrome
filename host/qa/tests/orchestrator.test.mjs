// Task 7 测试:编排器 runTask(全 mock,触发无关)。
// 断言:调用顺序;生成后必经人审 reviewScript 才重放;白名单外即停;写操作需确认;原生App门槛 fail-closed。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runTask } from '../orchestrator.mjs';

// 造一套可控 deps + 调用轨迹。
function makeDeps(over = {}) {
  const calls = [];
  const rec = (name) => (...a) => { calls.push(name); return a; };
  const base = {
    calls,
    readDoc: async () => { calls.push('readDoc'); return { content: 'PRD正文', refs: { links: [], mentions: [] }, hasTable: false }; },
    generate: async () => { calls.push('generate'); return { ok: true, script: { requirementIds: ['R1'], routeKey: '用户端-理财', steps: [{ action: 'assert_text', target: '标题', expected: '登录', requirementId: 'R1' }] } }; },
    reviewScript: async (script) => { calls.push('reviewScript'); return { approved: true, script }; },
    replayStep: async (step) => { calls.push('replayStep'); return { status: 'executed', actual: '登录', step }; },
    judge: (step, r) => { calls.push('judge'); return { verdict: 'pass', requirementId: step.requirementId, actual: r.actual }; },
    buildEvidence: (step, j) => ({ verdict: j.verdict, requirementId: step.requirementId }),
    resolveTargets: async () => { calls.push('resolveTargets'); return { ok: true, resultToken: 'AT', resultTableId: 'TID', chatId: 'oc_x', resultTableUrl: 'u', routingUrl: 'ru' }; },
    writeRunRecord: async () => { calls.push('writeRunRecord'); return 'rec1'; },
    broadcast: async () => { calls.push('broadcast'); return 'msg1'; },
    // 安全/门槛(默认放行)
    assertUrlAllowed: () => { calls.push('assertUrlAllowed'); },
    assertAppEnvGate: () => ({ web: true }),
    url: 'https://www-local.biconomy.vip/',
  };
  return { ...base, ...over };
}

test('正常链路:顺序正确,且 generate 后先 reviewScript 再 replayStep', async () => {
  const deps = makeDeps();
  const r = await runTask('prd-url', deps);
  assert.equal(r.ok, true);
  const c = deps.calls;
  assert.ok(c.indexOf('readDoc') < c.indexOf('generate'), 'readDoc 在 generate 前');
  assert.ok(c.indexOf('generate') < c.indexOf('reviewScript'), 'generate 在 reviewScript 前');
  assert.ok(c.indexOf('reviewScript') < c.indexOf('replayStep'), '人审在重放前(必经)');
  assert.ok(c.indexOf('replayStep') < c.indexOf('writeRunRecord'), '重放在写表前');
  assert.ok(c.indexOf('writeRunRecord') < c.indexOf('broadcast'), '写表在播报前');
});

test('人审否决 → 不重放、不写表', async () => {
  const deps = makeDeps({ reviewScript: async () => { return { approved: false }; } });
  const r = await runTask('prd-url', deps);
  assert.equal(r.ok, false);
  assert.ok(!deps.calls.includes('replayStep'), '否决后不应重放');
  assert.ok(!deps.calls.includes('writeRunRecord'), '否决后不应写表');
});

test('生成异常 → 停,不进人审/重放', async () => {
  const deps = makeDeps({ generate: async () => ({ ok: false, error: '脚本生成异常' }) });
  const r = await runTask('prd-url', deps);
  assert.equal(r.ok, false);
  assert.ok(!deps.calls.includes('reviewScript'));
  assert.ok(!deps.calls.includes('replayStep'));
});

test('原生App 门槛 fail-closed:门槛抛错 → 停', async () => {
  const deps = makeDeps({
    generate: async () => ({ ok: true, script: { requirementIds: ['R1'], routeKey: '安卓App-理财', steps: [{ action: 'assert_text', target: 't', expected: 'x', requirementId: 'R1' }] } }),
    assertAppEnvGate: () => { const e = new Error('app_env_not_ready'); e.code = 'app_env_not_ready'; throw e; },
  });
  const r = await runTask('prd-url', deps);
  assert.equal(r.ok, false);
  assert.ok(!deps.calls.includes('replayStep'), '门槛拦下,不重放');
});

test('replayStep 抛白名单错 → 整体停', async () => {
  const deps = makeDeps({ replayStep: async () => { const e = new Error('env_not_whitelisted'); e.code = 'env_not_whitelisted'; throw e; } });
  const r = await runTask('prd-url', deps);
  assert.equal(r.ok, false);
  assert.equal(r.error?.code || r.reason, 'env_not_whitelisted');
});
