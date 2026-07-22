// 组装 runTask 的真实依赖(run-task 命令行 与 侧栏 /qa 命令 共用)。
// 差异化的 reviewScript(人审)/ confirm(写操作确认)/ connectBrowser(浏览器起法)由调用方传入。
import { readDoc, writeRunRecord, broadcast } from './lark-client.mjs';
import { generate } from './script-gen.mjs';
import { replayStep } from './replayer.mjs';
import { judge, buildEvidence } from './verdict.mjs';
import { summarize } from './report.mjs';
import { resolveTargets, findRoutingBase, readRoutes } from './routing.mjs';
import * as safety from './safety.mjs';
import { assertAppEnvGate } from './app-gate.mjs';
import * as systemsMemory from './systems-memory.mjs';

// 命中记忆导航后,给页面一点加载时间再建图(navigate 返回时仅代表导航已发起,非加载完成)。
const NAV_SETTLE_MS = Number(process.env.CLAUDE_SIDEBAR_QA_NAV_SETTLE_MS || 2000);

// page_context 结果里取当前页真实 URL(字段位置不固定,逐一兜底)。
function pcUrl(pc) {
  if (!pc || typeof pc !== 'object') return '';
  return String(pc.url || pc.page?.url || pc.identity?.url || pc.current?.url || pc.pageContext?.url || '');
}
// URL 是否像登录页(命中任一关键词)。
function isLoginUrl(url, keywords) {
  const u = String(url || '').toLowerCase();
  return (Array.isArray(keywords) ? keywords : []).some((k) => k && u.includes(String(k).toLowerCase()));
}

// buildRealDeps({ client, cfg, connectBrowser, pinnedTab, entryUrlOverride, onProgress, reviewScript, confirm }) → runTask 的 deps。
//   client            飞书 SDK client
//   cfg               loadQaConfig() 结果(envWhitelist/writeKeywords/writeActions)
//   connectBrowser()  懒起浏览器:返回一个已连接的 BrowserClient(建图时机 = 定了目标之后)
//   pinnedTab         { tabId, url } 当前打开的页(侧栏默认目标);无则为 null
//   entryUrlOverride  手输被测页 URL(fallback,pinnedTab 为空时用)
//   onProgress(label) 进度回调(生成期 stream 进度 + 建图提示)
//   reviewScript(script) → { approved, script, edited? }
//   confirm(step) → boolean(写操作二次确认)
function buildRealDeps({ client, cfg, connectBrowser, pinnedTab, entryUrlOverride, onProgress, reviewScript, confirm, onLoginRequired }) {
  let bc = null;         // 浏览器客户端(prepareTarget 时懒建)
  let pageRef = null;    // 建图后 locate/read/act 复用的页引用:{tabId} 或 {pageQuery}
  return {
    whitelist: cfg.envWhitelist,
    rules: cfg,
    pinnedTab: pinnedTab || null,
    entryUrlOverride: entryUrlOverride || null,
    readDoc: (u) => readDoc(u, { client }),
    // 读路由总表已有键(端-系统模块),喂给生成器让 AI 选 routeKey。
    listRouteKeys: async () => {
      const base = await findRoutingBase(client);
      const routes = await readRoutes(client, base.appToken);
      return routes.map((r) => `${r.端}-${r.系统模块}`).filter((k) => k && k !== '-');
    },
    generate: (prd, { routeKeys } = {}) => generate(prd, { routeKeys, entryUrlOverride, onProgress }),
    reviewScript,
    onLoginRequired, // 落到登录页时暂停(触发层实现:提示用户登录后继续)
    // 访问录读写(项目记忆):查已记入口 / 首次沉淀。
    lookupSystem: (routeKey, featureMenu) => systemsMemory.lookup(routeKey, featureMenu),
    recordSystem: (routeKey, featureMenu, url, opts) => systemsMemory.record(routeKey, featureMenu, url, undefined, opts),
    // 定目标后建图。命中记忆(navigate=true)先把 tab 导到记录 URL(复用会话)再建图。
    // 导航后读重定向后的真实 URL:像登录页且 pauseOnLogin → 先不建图,返回 {isLogin:true} 让编排器暂停等登录。
    // url 过白名单(白名单外/非法 → 抛错停)。有 tabId → 固定 tab;否则按 url(pageQuery)。
    // 返回 { url: 解析后真实URL, isLogin }。
    prepareTarget: async (target, { pauseOnLogin = true } = {}) => {
      const url = target?.url || '';
      if (url) safety.assertUrlAllowed(url, cfg.envWhitelist);
      bc = await connectBrowser();
      let resolvedUrl = url;
      if (target?.navigate && url) {
        onProgress?.(`导航到 ${url} …`);
        await bc.navigate({ tabId: target.tabId || undefined, url });
        await new Promise((r) => setTimeout(r, NAV_SETTLE_MS)); // 等页面加载
        try {
          const got = pcUrl(await bc.pageContext({ tabId: target.tabId || undefined }));
          if (got) resolvedUrl = got;
        } catch { /* 读不到就退回请求 URL,登录检测降级为不触发 */ }
      }
      if (pauseOnLogin && isLoginUrl(resolvedUrl, cfg.loginUrlKeywords)) {
        return { url: resolvedUrl, isLogin: true }; // 交编排器暂停等登录,先不建图
      }
      pageRef = target?.tabId ? { tabId: target.tabId } : { pageQuery: url };
      onProgress?.(`建图 ${target?.tabId ? `当前页 tab#${target.tabId}` : url} …`);
      await bc.map(pageRef);
      return { url: resolvedUrl, isLogin: false };
    },
    replayStep: (step, stepDeps = {}) => replayStep(step, {
      url: stepDeps.target?.url || '',
      whitelist: cfg.envWhitelist,
      rules: cfg,
      safety,
      locate: async ({ query }) => bc.locate({ query, ...pageRef, limit: 5 }),
      read: async (anchor) => bc.read({ id: anchor.id, ...pageRef }),
      act: async (anchor, s) => bc.act({ id: anchor.id, action: s.action, value: s.value, confirmed: true, ...pageRef }),
      confirm,
    }),
    judge,
    buildEvidence,
    summarize,
    assertAppEnvGate: (端) => assertAppEnvGate(端),
    resolveTargets: (routeKey) => resolveTargets(client, routeKey),
    writeRunRecord: (token, tableId, fields) => writeRunRecord(client, token, tableId, fields),
    broadcast: (chatId, text) => broadcast(client, chatId, text),
    // 收尾:关掉懒起的浏览器(调用方 finally 里调)。
    closeBrowser: () => { try { bc?.close(); } catch {} },
  };
}

export { buildRealDeps };
