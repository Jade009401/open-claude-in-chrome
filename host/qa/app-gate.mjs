// 原生 App 环境门槛(设计定稿:App 走独立轨道,缺环境 fail-closed)。
// Phase 0 不建移动自动化栈 → 环境默认不齐 → 原生 App 场景一律被拒,不假装能测。
// 网页端(运营后台 / 用户端 web)直接放行,走既有浏览器流程。

// 端标识里表示"原生 App"的取值(可扩充)。
const NATIVE_APP_ENDS = ['安卓app', 'android app', 'androidapp', 'ios app', 'iosapp', 'android', 'ios'];

function isNativeAppEnd(端) {
  return NATIVE_APP_ENDS.includes(String(端 || '').trim().toLowerCase());
}

function platformOf(端) {
  const s = String(端 || '').toLowerCase();
  if (s.includes('ios')) return 'ios';
  if (s.includes('安卓') || s.includes('android')) return 'android';
  return null;
}

// 检查移动自动化环境是否就绪(env 可注入以便测试)。Phase 0 通常都缺 → not ready。
function checkMobileEnv(platform, env = process.env) {
  const missing = [];
  if (!env.APPIUM_URL) missing.push('APPIUM_URL');
  if (platform === 'android' && !(env.ANDROID_HOME || env.ANDROID_SDK_ROOT)) missing.push('ANDROID_HOME');
  if (platform === 'ios' && !env.IOS_DEVICE_UDID) missing.push('IOS_DEVICE_UDID');
  return { ready: missing.length === 0, missing };
}

// 门槛:原生 App 端且环境不齐 → 抛 app_env_not_ready(fail-closed)。网页端放行。
function assertAppEnvGate(端, env = process.env) {
  if (!isNativeAppEnd(端)) return { web: true };
  const platform = platformOf(端);
  const chk = checkMobileEnv(platform, env);
  if (!chk.ready) {
    const e = new Error(
      `原生 App(${platform})测试需要移动自动化环境,缺: ${chk.missing.join(', ')};` +
        `Phase 0 未配置,跳过(App 驱动栈单独立项)。`,
    );
    e.code = 'app_env_not_ready';
    e.platform = platform;
    e.missing = chk.missing;
    throw e;
  }
  return { web: false, platform };
}

export { isNativeAppEnd, platformOf, checkMobileEnv, assertAppEnvGate, NATIVE_APP_ENDS };
