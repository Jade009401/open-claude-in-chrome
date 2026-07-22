// 三态判定 + 证据组装(Task 5,纯函数)。截图路径/DOM 快照由上层注入。
// 原则:通过=轻(精简),失败/不确定=重(详证据);拿不准不硬判;判定溯源到 PRD requirementId。

// 归一化文本比较用:去首尾空白、压缩空白、小写。
function norm(v) {
  return String(v ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

// judge(step, result) → { verdict: 'pass'|'fail'|'uncertain', ... }
// result 来自 replayer:{ status:'executed', actual } / {status:'uncertain'} / {status:'blocked_need_confirm'}
function judge(step, result = {}) {
  // 上游非 executed(锚点未命中 / 待人工确认 / 前置缺失)→ 一律 uncertain,不硬判。
  if (result.status !== 'executed') {
    return { verdict: 'uncertain', reason: result.reason || result.status || 'not_executed', requirementId: step?.requirementId };
  }
  const expected = step?.expected;
  const actual = result.actual;
  // 没有明确期望,或实际拿不到 → uncertain。
  if (expected === undefined || expected === null || expected === '' || actual === undefined || actual === null) {
    return { verdict: 'uncertain', reason: 'no_clear_expected_or_actual', requirementId: step?.requirementId };
  }
  // 明确一致 → pass;明确不符 → fail(包含匹配:实际含期望即视为一致,适配文本片段)。
  const e = norm(expected);
  const a = norm(actual);
  const match = a === e || a.includes(e);
  return { verdict: match ? 'pass' : 'fail', expected, actual, requirementId: step?.requirementId };
}

// buildEvidence(step, judged) → 证据对象。通过=精简;失败/不确定=详细。
// 截图/DOM 快照引用由上层通过 opts 注入(Phase 0 去截图化 → 用 DOM 读回快照)。
function buildEvidence(step, judged = {}, opts = {}) {
  const verdict = judged.verdict || 'uncertain';
  const detailed = verdict !== 'pass'; // 通过精简,其余详细
  const base = {
    verdict,
    requirementId: step?.requirementId ?? null, // 判定溯源到 PRD 哪条需求
    action: step?.action ?? null,
    target: step?.target ?? null,
    detailed,
  };
  if (!detailed) {
    // 通过:只留最小痕迹
    return { ...base, note: '通过', snapshotRef: opts.snapshotRef ?? null };
  }
  // 失败/不确定:期望 vs 实际 + 原因 + 快照引用
  return {
    ...base,
    expected: step?.expected ?? null,
    actual: judged.actual ?? null,
    reason: judged.reason ?? null,
    snapshotRef: opts.snapshotRef ?? null, // DOM 读回快照(去截图化);有截图能力时可换成截图引用
  };
}

export { judge, buildEvidence };
