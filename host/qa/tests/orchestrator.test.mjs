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
    listRouteKeys: async () => { calls.push('listRouteKeys'); return ['用户端-理财']; },
    generate: async (prd, opts) => { calls.push('generate'); calls.lastGenOpts = opts; return { ok: true, script: { requirementIds: ['R1'], routeKey: '用户端-理财', featureMenu: '理财 > 首页', entryUrl: 'https://www-local.biconomy.vip/finance', steps: [{ action: 'assert_text', target: '标题', expected: '登录', requirementId: 'R1' }] } }; },
    reviewScript: async (script) => { calls.push('reviewScript'); return { approved: true, script }; },
    pinnedTab: { tabId: 42, url: 'https://www-local.biconomy.vip/finance' },
    lookupSystem: () => null, // 默认未命中(首次)
    recordSystem: (rk, fm, url) => { calls.push('recordSystem'); calls.lastRecord = { rk, fm, url }; return true; },
    prepareTarget: async (target) => { calls.push('prepareTarget'); calls.lastTarget = target; },
    replayStep: async (step) => { calls.push('replayStep'); return { status: 'executed', actual: '登录', step }; },
    judge: (step, r) => { calls.push('judge'); return { verdict: 'pass', requirementId: step.requirementId, actual: r.actual }; },
    buildEvidence: (step, j) => ({ verdict: j.verdict, requirementId: step.requirementId }),
    resolveTargets: async () => { calls.push('resolveTargets'); return { ok: true, resultToken: 'AT', resultTableId: 'TID', chatId: 'oc_x', resultTableUrl: 'u', routingUrl: 'ru' }; },
    writeRunRecord: async () => { calls.push('writeRunRecord'); return 'rec1'; },
    broadcast: async () => { calls.push('broadcast'); return 'msg1'; },
    // 安全/门槛(默认放行)
    assertAppEnvGate: () => ({ web: true }),
  };
  return { ...base, ...over };
}

test('正常链路:顺序正确,且 generate 后先 reviewScript 再 replayStep', async () => {
  const deps = makeDeps();
  const r = await runTask('prd-url', deps);
  assert.equal(r.ok, true);
  const c = deps.calls;
  assert.ok(c.indexOf('readDoc') < c.indexOf('listRouteKeys'), '读 PRD 在读路由键前');
  assert.ok(c.indexOf('listRouteKeys') < c.indexOf('generate'), '路由键先读再生成(喂给 AI 选 routeKey)');
  assert.ok(c.indexOf('generate') < c.indexOf('reviewScript'), 'generate 在 reviewScript 前');
  assert.ok(c.indexOf('reviewScript') < c.indexOf('prepareTarget'), '人审在建图前');
  assert.ok(c.indexOf('prepareTarget') < c.indexOf('replayStep'), '建图在重放前');
  assert.ok(c.indexOf('replayStep') < c.indexOf('writeRunRecord'), '重放在写表前');
  assert.ok(c.indexOf('writeRunRecord') < c.indexOf('broadcast'), '写表在播报前');
  assert.deepEqual(deps.calls.lastGenOpts?.routeKeys, ['用户端-理财'], 'generate 应拿到路由键列表');
  assert.equal(deps.calls.lastTarget?.tabId, 42, '首次未命中记忆 → 用固定 tab 当被测目标');
  assert.equal(deps.calls.lastTarget?.navigate, false, '首次不导航(测当前页)');
  assert.ok(deps.calls.includes('recordSystem'), '首次跑完应沉淀访问录');
  assert.equal(deps.calls.lastRecord?.fm, '理财 > 首页', '沉淀键=功能菜单');
});

test('落在登录页 → 暂停(onLoginRequired)后重试一次再重放', async () => {
  let prepCalls = 0;
  const deps = makeDeps({
    prepareTarget: async () => { prepCalls += 1; deps.calls.push('prepareTarget'); return { url: 'https://ea/login', isLogin: prepCalls === 1 }; },
    onLoginRequired: async () => { deps.calls.push('onLoginRequired'); },
  });
  const r = await runTask('prd-url', deps);
  assert.equal(r.ok, true);
  assert.equal(prepCalls, 2, 'prepareTarget 调两次(登录后重试)');
  assert.ok(deps.calls.includes('onLoginRequired'), '应暂停等登录');
  assert.ok(deps.calls.indexOf('onLoginRequired') < deps.calls.indexOf('replayStep'), '登录在重放前');
});

test('记忆命中 → 自动导航到记录 URL,不再沉淀', async () => {
  const deps = makeDeps({
    lookupSystem: () => ({ url: 'https://mem/vip', note: '' }),
  });
  await runTask('prd-url', deps);
  assert.equal(deps.calls.lastTarget?.url, 'https://mem/vip', '目标=记忆里的 URL');
  assert.equal(deps.calls.lastTarget?.navigate, true, '命中应自动导航');
  assert.equal(deps.calls.lastTarget?.tabId, 42, '导航固定 tab');
  assert.ok(!deps.calls.includes('recordSystem'), '命中不再沉淀');
});

test('固定 tab 优先于 PRD entryUrl(首次未命中时)', async () => {
  const deps = makeDeps({
    generate: async () => ({ ok: true, script: { requirementIds: ['R1'], routeKey: '用户端-理财', featureMenu: 'f', entryUrl: 'https://other.example/x', steps: [{ action: 'assert_text', target: 't', expected: 'x', requirementId: 'R1' }] } }),
  });
  await runTask('prd-url', deps);
  assert.equal(deps.calls.lastTarget?.tabId, 42, '有固定 tab 时忽略 script.entryUrl');
});

test('无 tab / 无 URL / 无 entryUrl → 停在 entry(no_target)', async () => {
  const deps = makeDeps({
    pinnedTab: null,
    generate: async () => ({ ok: true, script: { requirementIds: ['R1'], routeKey: '用户端-理财', steps: [{ action: 'assert_text', target: 't', expected: 'x', requirementId: 'R1' }] } }),
  });
  const r = await runTask('prd-url', deps);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no_target');
  assert.ok(!deps.calls.includes('prepareTarget'), '无目标不该建图');
  assert.ok(!deps.calls.includes('replayStep'), '无目标不该重放');
});

test('无 tab 但有 PRD entryUrl → 用 url 建图', async () => {
  const deps = makeDeps({
    pinnedTab: null,
    generate: async () => ({ ok: true, script: { requirementIds: ['R1'], routeKey: '用户端-理财', entryUrl: 'https://www-local.biconomy.vip/x', steps: [{ action: 'assert_text', target: 't', expected: 'x', requirementId: 'R1' }] } }),
  });
  await runTask('prd-url', deps);
  assert.equal(deps.calls.lastTarget?.url, 'https://www-local.biconomy.vip/x', 'fallback 到 entryUrl');
  assert.ok(!deps.calls.lastTarget?.tabId, '无 tabId');
});

test('prepareTarget 抛白名单错(建图前) → 停在 prepare,不重放', async () => {
  const deps = makeDeps({
    prepareTarget: async () => { const e = new Error('URL 不在白名单'); e.code = 'env_not_whitelisted'; throw e; },
  });
  const r = await runTask('prd-url', deps);
  assert.equal(r.ok, false);
  assert.equal(r.error?.code || r.reason, 'env_not_whitelisted');
  assert.ok(!deps.calls.includes('replayStep'), '建图失败不该重放');
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
