// Task 6 测试:汇总 summarize + 止损指标 computeStopMetrics(纯函数)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarize, computeStopMetrics, formatRunResult } from '../report.mjs';

// —— formatRunResult:结果块(每步三态 + 落库/降级状态)——
const RUN = {
  routeKey: '运营后台-VIP配置',
  summary: { pass: 1, fail: 0, uncertain: 1, coverage: '2/2' },
  durationMs: 1234,
  stepResults: [
    { step: { action: 'assert_text', target: '标题', expected: '登录' }, judged: { verdict: 'pass', actual: '登录' } },
    { step: { action: 'read', target: '费率' }, judged: { verdict: 'uncertain', reason: 'anchor_not_found' } },
  ],
};

test('formatRunResult:自动建行 → 显示已写共享表 + 自动加行', () => {
  const out = formatRunResult({ ...RUN, routed: true, autoCreated: true, broadcasted: false, resultTableUrl: 'https://x/base/Q' });
  assert.match(out, /✅1 .* ❌0 .* ❓1/);
  assert.match(out, /自动加行/);
  assert.match(out, /跳过播报/);
  assert.match(out, /anchor_not_found/, '不确定步显示原因');
});

test('formatRunResult:降级(未写飞书)照显结果 + 原因', () => {
  const out = formatRunResult({ ...RUN, routed: false, routingError: 'boom' });
  assert.match(out, /未写飞书/);
  assert.match(out, /boom/);
});

// —— summarize:统计三态 + 覆盖率 M/N ——
test('summarize:统计过/败/不确定 + 覆盖率', () => {
  const items = [
    { verdict: 'pass', requirementId: 'R1' },
    { verdict: 'pass', requirementId: 'R2' },
    { verdict: 'fail', requirementId: 'R3' },
    { verdict: 'uncertain', requirementId: 'R3' },
  ];
  const s = summarize(items, ['R1', 'R2', 'R3', 'R4']); // 全集 4 条,被测 3 条
  assert.equal(s.pass, 2);
  assert.equal(s.fail, 1);
  assert.equal(s.uncertain, 1);
  assert.equal(s.coverage, '3/4'); // R1/R2/R3 被覆盖,R4 漏
});

// —— computeStopMetrics:改判率 = 被推翻的"通过" / AI判定"通过"数 ——
test('改判率 = 推翻通过数 / AI通过数(分母只含 AI 通过)', () => {
  const rows = [
    { aiVerdict: 'pass', humanOverturn: '是', durationMs: 1000 }, // 通过被推翻
    { aiVerdict: 'pass', humanOverturn: '否', durationMs: 2000 },
    { aiVerdict: 'pass', humanOverturn: '', durationMs: 3000 }, // 空=未改判
    { aiVerdict: 'fail', humanOverturn: '否', durationMs: 500 }, // 非通过,不进分母
  ];
  const m = computeStopMetrics(rows);
  assert.equal(m.aiPassCount, 3);
  assert.equal(m.overturnedPassCount, 1);
  assert.equal(m.改判率, 1 / 3);
});

test('平均耗时 = 所有行耗时均值', () => {
  const rows = [
    { aiVerdict: 'pass', humanOverturn: '否', durationMs: 1000 },
    { aiVerdict: 'fail', humanOverturn: '否', durationMs: 3000 },
  ];
  assert.equal(computeStopMetrics(rows).平均耗时ms, 2000);
});

test('无 AI 通过用例 → 改判率为 null(避免除零),不误判达标', () => {
  const rows = [{ aiVerdict: 'fail', humanOverturn: '否', durationMs: 100 }];
  assert.equal(computeStopMetrics(rows).改判率, null);
});

test('识别中文"通过" + 布尔 true 改判', () => {
  const rows = [
    { aiVerdict: '通过', humanOverturn: true, durationMs: 100 },
    { aiVerdict: '通过', humanOverturn: false, durationMs: 100 },
  ];
  const m = computeStopMetrics(rows);
  assert.equal(m.aiPassCount, 2);
  assert.equal(m.overturnedPassCount, 1);
  assert.equal(m.改判率, 0.5);
});
