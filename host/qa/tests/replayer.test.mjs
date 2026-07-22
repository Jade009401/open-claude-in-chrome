// Task 4 测试:重放器 replayStep(mock 底层 locate/read/act/confirm)。
// 重点:是否写操作必须由 safety 判定(不许 replayer 自判);写操作无确认→blocked;
// 锚点未命中→uncertain(不自愈);白名单外→抛错。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as realSafety from '../safety.mjs';
import { replayStep } from '../replayer.mjs';

// 监听 safety 是否被调用,同时委托真实实现。
function spySafety() {
  const calls = { assertUrlAllowed: 0, classifyAction: 0, requiresHumanConfirm: 0 };
  return {
    calls,
    assertUrlAllowed: (...a) => { calls.assertUrlAllowed += 1; return realSafety.assertUrlAllowed(...a); },
    classifyAction: (...a) => { calls.classifyAction += 1; return realSafety.classifyAction(...a); },
    requiresHumanConfirm: (...a) => { calls.requiresHumanConfirm += 1; return realSafety.requiresHumanConfirm(...a); },
  };
}

const RULES = { writeActions: ['click', 'input', 'select', 'submit'], writeKeywords: ['删除', '支付'] };
const baseDeps = (over = {}) => ({
  url: 'https://www-local.biconomy.vip/login',
  whitelist: ['www-local.biconomy.vip'],
  rules: RULES,
  locate: async () => ({ matches: [{ id: 'a1', locator: 'loc1' }] }),
  read: async () => ({ actual: '登录' }),
  act: async () => ({ actual: 'clicked' }),
  confirm: async () => false,
  ...over,
});

test('只读断言:锚点命中 → executed + 拿到 actual;classifyAction 被调用', async () => {
  const safety = spySafety();
  const r = await replayStep({ action: 'assert_text', target: '标题', expected: '登录', requirementId: 'R1' }, baseDeps({ safety }));
  assert.equal(r.status, 'executed');
  assert.equal(r.actual, '登录');
  assert.ok(safety.calls.classifyAction >= 1, 'classifyAction 应被调用');
});

test('锚点未命中 → uncertain(不自愈)', async () => {
  const r = await replayStep(
    { action: 'assert_text', target: '不存在', expected: 'x', requirementId: 'R1' },
    baseDeps({ locate: async () => ({ matches: [] }) }),
  );
  assert.equal(r.status, 'uncertain');
});

test('写操作无确认 → blocked_need_confirm;requiresHumanConfirm 被调用', async () => {
  const safety = spySafety();
  const r = await replayStep(
    { action: 'click', target: '提交按钮', requirementId: 'R1' },
    baseDeps({ safety, confirm: async () => false }),
  );
  assert.equal(r.status, 'blocked_need_confirm');
  assert.ok(safety.calls.requiresHumanConfirm >= 1, 'requiresHumanConfirm 应被调用');
});

test('写操作已确认 → executed 且 act 被调用', async () => {
  let acted = false;
  const r = await replayStep(
    { action: 'click', target: '登录按钮', requirementId: 'R1' },
    baseDeps({ confirm: async () => true, act: async () => { acted = true; return { actual: 'ok' }; } }),
  );
  assert.equal(r.status, 'executed');
  assert.equal(acted, true);
});

test('白名单外域名 → 抛错(整个任务应停)', async () => {
  await assert.rejects(
    () => replayStep({ action: 'assert_text', target: 't', requirementId: 'R1' }, baseDeps({ url: 'https://www.biconomy.com/' })),
  );
});
