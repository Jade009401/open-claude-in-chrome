// 脚本重放器(Task 4):确定性重放,只读断言,无自愈。
// - 执行前先过环境白名单(白名单外抛错 → 整个任务停)。
// - "是否写操作"由 safety 判定,replayer 不自判;写操作无人工确认 → blocked,绝不自传 confirmed。
// - 锚点未命中 → uncertain(不重定位、不猜)。
// - 只读断言:读取 actual 交给上层(Task 5 judge)比对 expected;replayer 不下 pass/fail。
import * as defaultSafety from './safety.mjs';

// deps: { url, whitelist, rules, locate, read, act, confirm, safety? }
// safety 默认取 './safety.mjs';允许注入以便测试断言其被调用。
async function replayStep(step, deps = {}) {
  const safety = deps.safety || defaultSafety;

  // 1. 环境白名单:白名单外直接抛错(生产/未知域名),由编排器停下。
  safety.assertUrlAllowed(deps.url, deps.whitelist);

  // 2. 是否写操作 —— 必须由 safety 判定,不许 replayer 自行判定。
  const classification = safety.classifyAction(step, deps.rules);

  // 3. 写操作:需人工确认才执行;无确认 → blocked_need_confirm,绝不自传 confirmed。
  if (classification.write) {
    const need = safety.requiresHumanConfirm(step, deps.rules);
    if (need) {
      const confirmed = deps.confirm ? await deps.confirm(step) : false;
      if (confirmed !== true) {
        return { status: 'blocked_need_confirm', step, classification };
      }
    }
  }

  // 4. 定位锚点(无自愈:找不到即 uncertain)。
  const located = await deps.locate({ query: step.target });
  const matches = located?.matches || located?.candidates || [];
  const anchor = Array.isArray(matches) ? matches[0] : null;
  if (!anchor) {
    return { status: 'uncertain', reason: 'anchor_not_found', step, classification };
  }

  // 5. 执行:写(已确认)→ act;只读 → read 取 actual(不做重定位)。
  if (classification.write) {
    const actResult = await deps.act(anchor, step);
    return { status: 'executed', actual: actResult?.actual ?? null, anchor, step, classification };
  }
  const readResult = await deps.read(anchor, step);
  const actual = readResult?.actual ?? readResult?.text ?? (typeof readResult === 'string' ? readResult : null);
  return { status: 'executed', actual, anchor, step, classification };
}

export { replayStep };
