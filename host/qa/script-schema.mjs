// 脚本 schema + 校验(Task 3,纯函数)。
// 脚本 = { requirementIds: string[], steps: Step[] }
// Step  = { action, target, expected, requirementId }

// 动作枚举。只读类 + 写类(写类须与 safety.writeActions 对齐:click/input/select/submit)。
const READONLY_ACTIONS = ['navigate', 'assert_text', 'assert_visible', 'assert_exists', 'read', 'scroll'];
const WRITE_ACTIONS = ['click', 'input', 'select', 'submit'];
const ACTIONS = new Set([...READONLY_ACTIONS, ...WRITE_ACTIONS]);

// 校验一份脚本。返回 { ok, errors:[] }。不抛错。
function validateScript(obj) {
  const errors = [];
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, errors: ['脚本不是对象'] };
  }
  const reqIds = obj.requirementIds;
  const reqOk = Array.isArray(reqIds) && reqIds.length > 0 && reqIds.every((r) => typeof r === 'string' && r);
  if (!reqOk) errors.push('requirementIds 必须是非空字符串数组');
  const reqSet = new Set(Array.isArray(reqIds) ? reqIds : []);

  const steps = obj.steps;
  if (!Array.isArray(steps) || steps.length === 0) {
    errors.push('steps 必须是非空数组');
  } else {
    steps.forEach((s, i) => {
      if (!s || typeof s !== 'object') {
        errors.push(`step[${i}] 不是对象`);
        return;
      }
      if (!ACTIONS.has(String(s.action))) errors.push(`step[${i}] 未知 action: ${s.action}`);
      if (!s.requirementId) errors.push(`step[${i}] 缺 requirementId`);
      else if (reqSet.size && !reqSet.has(s.requirementId)) {
        errors.push(`step[${i}] requirementId "${s.requirementId}" 不在 requirementIds 内`);
      }
      // target:除 navigate 外必填(定位对象)
      if (s.action !== 'navigate' && !s.target) errors.push(`step[${i}] 缺 target`);
    });
    // C:覆盖率硬检查 —— 每条需求至少有一个步骤覆盖,漏了就报错(挡住悄悄漏测)。
    if (reqOk) {
      const covered = new Set(steps.map((s) => s?.requirementId).filter(Boolean));
      for (const rid of reqSet) {
        if (!covered.has(rid)) errors.push(`需求 ${rid} 无步骤覆盖(漏测)`);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

export { validateScript, ACTIONS, READONLY_ACTIONS, WRITE_ACTIONS };
