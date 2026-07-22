// 脚本 schema + 校验(Task 3,纯函数)。
// 脚本 = { requirementIds: string[], routeKey: string, featureMenu?: string, entryUrl?: string, steps: Step[] }
// Step  = { action, target, expected, requirementId }
// routeKey:路由键(端-系统模块);AI 选不出可填「待人工」,校验只要求非空。
// featureMenu:被测功能在后台的菜单路径(如「系统配置 > VIP配置」),**可选**。
//             与 routeKey 一起作访问录的键,首次自动沉淀入口 URL、之后自动导航。单页应用可空。
// entryUrl:被测入口 URL,**可选**。默认测「当前打开的浏览器 tab」(触发层固定 tabId),
//           故不强制;PRD 明确写了被测地址才填,作为无当前页时的 fallback。

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
  // routeKey 必填(触发层据此路由)。featureMenu / entryUrl 可选(present 时须为字符串)。
  if (typeof obj.routeKey !== 'string' || !obj.routeKey.trim()) {
    errors.push('缺 routeKey(路由键;AI 选不出请填「待人工」)');
  }
  if (obj.featureMenu != null && typeof obj.featureMenu !== 'string') errors.push('featureMenu 必须是字符串');
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
