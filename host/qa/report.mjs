// 汇总报告 + 止损指标(Task 6 纯函数部分)。
// 播报(im)/写 Base(bitable)的 IO 在 lark-client.mjs,需飞书 Base/群配置,另做。

// 把 AI 判定值归一到 pass/fail/uncertain(容忍中英文)。
function normVerdict(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (s === 'pass' || s === '通过') return 'pass';
  if (s === 'fail' || s === '失败' || s === '不通过') return 'fail';
  return 'uncertain';
}

// 是否人工改判(容忍 是/true/yes;空/否/false=未改判)。
function isOverturned(v) {
  if (v === true) return true;
  const s = String(v ?? '').trim().toLowerCase();
  return s === '是' || s === 'true' || s === 'yes' || s === 'y' || s === '1';
}

// summarize(items, allRequirementIds) → { pass, fail, uncertain, total, coverage:'M/N', coverageRatio }
// items:每条判定 { verdict, requirementId };coverage = 被覆盖需求数 / 需求全集 N。
function summarize(items = [], allRequirementIds = []) {
  const counts = { pass: 0, fail: 0, uncertain: 0 };
  const covered = new Set();
  for (const it of Array.isArray(items) ? items : []) {
    counts[normVerdict(it?.verdict)] += 1;
    if (it?.requirementId) covered.add(it.requirementId);
  }
  const all = Array.isArray(allRequirementIds) ? allRequirementIds : [];
  const N = all.length;
  const M = all.filter((r) => covered.has(r)).length;
  return {
    ...counts,
    total: counts.pass + counts.fail + counts.uncertain,
    coverage: `${M}/${N}`,
    coverageRatio: N ? M / N : null,
  };
}

// computeStopMetrics(baseRows) → { aiPassCount, overturnedPassCount, 改判率, 平均耗时ms }
// 改判率 = 被人工推翻的"通过"数 / AI 判定为"通过"的用例数(分母只含 AI 通过,对齐 spec §3)。
// 分母为 0 → 改判率 = null(避免除零误判达标)。平均耗时 = 全部行耗时均值。
function computeStopMetrics(baseRows = []) {
  const rows = Array.isArray(baseRows) ? baseRows : [];
  let aiPassCount = 0;
  let overturnedPassCount = 0;
  let durationSum = 0;
  let durationCount = 0;
  for (const r of rows) {
    if (normVerdict(r?.aiVerdict) === 'pass') {
      aiPassCount += 1;
      if (isOverturned(r?.humanOverturn)) overturnedPassCount += 1;
    }
    const d = Number(r?.durationMs);
    if (Number.isFinite(d)) { durationSum += d; durationCount += 1; }
  }
  return {
    aiPassCount,
    overturnedPassCount,
    改判率: aiPassCount > 0 ? overturnedPassCount / aiPassCount : null,
    平均耗时ms: durationCount > 0 ? durationSum / durationCount : null,
  };
}

export { summarize, computeStopMetrics, normVerdict, isOverturned };
