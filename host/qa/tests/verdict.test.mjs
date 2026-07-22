// Task 5 测试:三态判定 judge + 证据组装 buildEvidence(纯函数)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judge, buildEvidence } from '../verdict.mjs';

// —— judge:通过/失败/不确定 ——
test('期望与实际一致且明确 → pass', () => {
  const r = judge({ action: 'assert_text', expected: '登录', requirementId: 'R1' }, { status: 'executed', actual: '登录' });
  assert.equal(r.verdict, 'pass');
});

test('期望与实际明确不符 → fail', () => {
  const r = judge({ action: 'assert_text', expected: '登录', requirementId: 'R1' }, { status: 'executed', actual: '注册' });
  assert.equal(r.verdict, 'fail');
});

test('上游 uncertain(锚点未命中)→ uncertain', () => {
  const r = judge({ action: 'assert_text', expected: '登录', requirementId: 'R1' }, { status: 'uncertain', reason: 'anchor_not_found' });
  assert.equal(r.verdict, 'uncertain');
});

test('写操作待确认(blocked)→ uncertain(不硬判)', () => {
  const r = judge({ action: 'click', requirementId: 'R1' }, { status: 'blocked_need_confirm' });
  assert.equal(r.verdict, 'uncertain');
});

test('actual 缺失/拿不准 → uncertain', () => {
  const r = judge({ action: 'assert_text', expected: '登录', requirementId: 'R1' }, { status: 'executed', actual: null });
  assert.equal(r.verdict, 'uncertain');
});

// —— buildEvidence:通过精简,失败/不确定详细,均含 PRD 溯源 ——
test('通过 → 精简证据 + 溯源 requirementId', () => {
  const ev = buildEvidence(
    { action: 'assert_text', expected: '登录', requirementId: 'R1' },
    { verdict: 'pass', actual: '登录' },
  );
  assert.equal(ev.verdict, 'pass');
  assert.equal(ev.requirementId, 'R1');
  assert.equal(ev.detailed, false); // 通过=精简
});

test('失败 → 详细证据(期望 vs 实际)+ 溯源', () => {
  const ev = buildEvidence(
    { action: 'assert_text', expected: '登录', requirementId: 'R2' },
    { verdict: 'fail', actual: '注册' },
  );
  assert.equal(ev.verdict, 'fail');
  assert.equal(ev.detailed, true);
  assert.equal(ev.expected, '登录');
  assert.equal(ev.actual, '注册');
  assert.equal(ev.requirementId, 'R2');
});

test('不确定 → 详细证据', () => {
  const ev = buildEvidence({ action: 'assert_text', expected: 'x', requirementId: 'R1' }, { verdict: 'uncertain', reason: 'anchor_not_found' });
  assert.equal(ev.detailed, true);
});
