// Task 3 测试:脚本 schema 校验纯函数 validateScript。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateScript } from '../script-schema.mjs';

const VALID = {
  requirementIds: ['R1', 'R2'],
  routeKey: '用户端-理财',
  entryUrl: 'https://www-local.biconomy.vip/finance',
  steps: [
    { action: 'navigate', target: '登录页', expected: '', requirementId: 'R1' },
    { action: 'assert_text', target: '页面标题', expected: '登录', requirementId: 'R1' },
    { action: 'assert_text', target: '用户名框placeholder', expected: '请输入用户名', requirementId: 'R2' },
  ],
};

test('合法脚本通过', () => {
  const r = validateScript(VALID);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test('缺 requirementId 失败', () => {
  const bad = { requirementIds: ['R1'], steps: [{ action: 'assert_text', target: 't', expected: 'x' }] };
  assert.equal(validateScript(bad).ok, false);
});

test('未知 action 失败', () => {
  const bad = { requirementIds: ['R1'], steps: [{ action: 'teleport', target: 't', expected: 'x', requirementId: 'R1' }] };
  assert.equal(validateScript(bad).ok, false);
});

test('requirementId 不在全集内失败', () => {
  const bad = { requirementIds: ['R1'], steps: [{ action: 'assert_text', target: 't', expected: 'x', requirementId: 'R9' }] };
  assert.equal(validateScript(bad).ok, false);
});

test('C:有需求没被任何步骤覆盖 → 失败(漏测)', () => {
  const bad = {
    requirementIds: ['R1', 'R2'],
    steps: [{ action: 'assert_text', target: 't', expected: 'x', requirementId: 'R1' }], // R2 没覆盖
  };
  const r = validateScript(bad);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('R2')), '应报 R2 漏测');
});

test('requirementIds 空 / steps 空 失败', () => {
  assert.equal(validateScript({ requirementIds: [], steps: [] }).ok, false);
  assert.equal(validateScript({ requirementIds: ['R1'], steps: [] }).ok, false);
});

test('非对象输入不抛错,返回 ok:false', () => {
  assert.equal(validateScript(null).ok, false);
  assert.equal(validateScript('x').ok, false);
});

test('缺 routeKey 失败', () => {
  const { routeKey, ...bad } = VALID;
  const r = validateScript(bad);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('routeKey')), '应报 routeKey 缺失');
});

test('缺 entryUrl 也能过(默认测当前 tab,entryUrl 可选)', () => {
  const { entryUrl, ...noEntry } = VALID;
  const r = validateScript(noEntry);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test('routeKey 填「待人工」可过 schema(留到路由步骤暴露)', () => {
  const r = validateScript({ ...VALID, routeKey: '待人工' });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test('featureMenu 可选:带上能过,非字符串失败', () => {
  assert.equal(validateScript({ ...VALID, featureMenu: '系统配置 > VIP配置' }).ok, true);
  assert.equal(validateScript({ ...VALID, featureMenu: 123 }).ok, false);
});
