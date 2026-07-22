// 安全闸门纯函数(Task 2):环境白名单校验 + 写操作分类 + 需人工确认。
// 规则(白名单/关键词/动作)全从外部传入(见 config.loadQaConfig),不写死在逻辑里。

// url 的 host 是否在测试环境白名单内(含子域)。不在 → 抛错(生产/未知一律拒)。
// 空白名单 = 全拒(fail-safe)。
function assertUrlAllowed(url, whitelist) {
  let host;
  try {
    host = new URL(String(url)).hostname.toLowerCase();
  } catch {
    const e = new Error(`非法 URL: ${url}`);
    e.code = 'invalid_url';
    throw e;
  }
  const list = Array.isArray(whitelist) ? whitelist : [];
  const ok = list.some((d) => {
    const entry = String(d).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    return entry && (host === entry || host.endsWith(`.${entry}`));
  });
  if (!ok) {
    const e = new Error(`URL 不在测试环境白名单内,拒绝: ${host}`);
    e.code = 'env_not_whitelisted';
    throw e;
  }
}

// 分类一个步骤 → { readonly, write, destructive }。
// write = 动作属写类(改数据);destructive = 写类且文案命中危险关键词(删除/支付/…)。
function classifyAction(step, rules = {}) {
  const action = String(step?.action || '');
  const writeActions = Array.isArray(rules.writeActions) ? rules.writeActions : [];
  const writeKeywords = Array.isArray(rules.writeKeywords) ? rules.writeKeywords : [];
  const write = writeActions.includes(action);
  const haystack = [step?.target, step?.value, step?.text, step?.expected, step?.label]
    .filter(Boolean)
    .map(String)
    .join(' ')
    .toLowerCase();
  const destructive = write && writeKeywords.some((k) => haystack.includes(String(k).toLowerCase()));
  return { readonly: !write, write, destructive };
}

// Phase 0:一切写操作都需人工确认(破坏性动作更是必确认)。
function requiresHumanConfirm(step, rules = {}) {
  return classifyAction(step, rules).write === true;
}

export { assertUrlAllowed, classifyAction, requiresHumanConfirm };
