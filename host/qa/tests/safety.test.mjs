// Task 2 测试:安全闸门纯函数(白名单校验 + 写操作分类 + 需人工确认)。
// 规则(白名单/关键词/动作)全从外部传入,不写死在函数里。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertUrlAllowed, classifyAction, requiresHumanConfirm } from '../safety.mjs';

const WHITELIST = ['www-local.biconomy.vip', 'staging.example.com'];
const RULES = {
  writeActions: ['click', 'input', 'select', 'submit'],
  writeKeywords: ['删除', '支付', '提交', 'delete', 'pay'],
};

// —— assertUrlAllowed ——
test('白名单内域名放行', () => {
  assert.doesNotThrow(() => assertUrlAllowed('https://www-local.biconomy.vip/login', WHITELIST));
});

test('白名单域名的子域放行', () => {
  assert.doesNotThrow(() => assertUrlAllowed('https://app.staging.example.com/x', WHITELIST));
});

test('生产/未知域名抛错', () => {
  assert.throws(() => assertUrlAllowed('https://www.biconomy.com/', WHITELIST));
  assert.throws(() => assertUrlAllowed('https://evil.example.org/', WHITELIST));
});

test('空白名单=全拒(fail-safe)', () => {
  assert.throws(() => assertUrlAllowed('https://www-local.biconomy.vip/', []));
});

// —— classifyAction ——
test('只读断言动作 → readonly', () => {
  const c = classifyAction({ action: 'assert_text', target: '页面标题', expected: '登录' }, RULES);
  assert.equal(c.readonly, true);
  assert.equal(c.write, false);
  assert.equal(c.destructive, false);
});

test('普通点击 → write 但非 destructive', () => {
  const c = classifyAction({ action: 'click', target: '登录按钮' }, RULES);
  assert.equal(c.write, true);
  assert.equal(c.destructive, false);
});

test('点击"删除" → write + destructive(命中关键词)', () => {
  const c = classifyAction({ action: 'click', target: '删除订单' }, RULES);
  assert.equal(c.write, true);
  assert.equal(c.destructive, true);
});

test('submit → write', () => {
  assert.equal(classifyAction({ action: 'submit' }, RULES).write, true);
});

// —— requiresHumanConfirm ——
test('写操作需人工确认', () => {
  assert.equal(requiresHumanConfirm({ action: 'click', target: '登录' }, RULES), true);
  assert.equal(requiresHumanConfirm({ action: 'submit' }, RULES), true);
});

test('只读不需要确认', () => {
  assert.equal(requiresHumanConfirm({ action: 'assert_text', target: 't' }, RULES), false);
});
