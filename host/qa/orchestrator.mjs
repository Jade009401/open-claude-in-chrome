// QA 编排器(Task 7):把各模块串成一次任务。触发无关 —— runTask(prdInput, deps)。
// 依赖全注入,便于测试;真实接线(飞书/浏览器/claude)由触发层组装 deps 后调用。
//
// 链路:读PRD → 读路由键喂生成器 → 生成脚本(含 routeKey+entryUrl) →
//       (routeKey 若原生App 过环境门槛) → 人审(A,必经) →
//       用 script.entryUrl 建图(prepareTarget) → 逐步重放(先白名单校验、写操作需确认) →
//       三态判定+证据 → 汇总 → 按 routeKey 路由 → 写结果表 + 播报(含文档URL,透明)。
//
// deps: {
//   readDoc(prdInput), listRouteKeys()?, generate(prd,{routeKeys}), reviewScript(script),
//   prepareTarget(target,{pauseOnLogin})?→{url,isLogin}, onLoginRequired(url)?, replayStep(step, stepDeps),
//   judge(step,result), buildEvidence(step,judged),
//   resolveTargets(routeKey), writeRunRecord(token,tableId,fields), broadcast(chatId,text),
//   assertAppEnvGate(端)? , pinnedTab?{tabId,url}, entryUrlOverride?,
//   lookupSystem(routeKey,featureMenu)?→{url,note}|null, recordSystem(routeKey,featureMenu,url)?,
//   whitelist, rules, confirm, safety,
// }
// 被测目标 target = { tabId?, url, navigate?, source } —— navigate=true 先把 tab 导到 url 再建图;
//   有 tabId 走固定 tab,否则按 url(pageQuery)。source: memory|current_tab|override|prd_entry_url。

function fail(reason, extra = {}) {
  return { ok: false, reason: typeof reason === 'string' ? reason : reason?.code, error: reason, ...extra };
}

async function runTask(prdInput, deps = {}) {
  const t0 = Date.now();
  // 1. 读 PRD
  const prd = await deps.readDoc(prdInput);

  // 1.5 读路由总表已有键(best-effort),喂给生成器让 AI 选 routeKey;读不到就空表,让 AI 标「待人工」。
  let routeKeys = [];
  if (deps.listRouteKeys) {
    try { routeKeys = await deps.listRouteKeys(); } catch { routeKeys = []; }
  }

  // 2. 生成脚本(headless claude,B′):产出含 routeKey + entryUrl。
  const gen = await deps.generate(prd, { routeKeys });
  if (!gen?.ok) return fail(gen?.error || '脚本生成异常', { stage: 'generate', reason: gen?.reason });
  const script0 = gen.script;

  // 3. 原生 App 环境门槛(fail-closed):按脚本 routeKey 的"端"判定
  const 端 = String(script0?.routeKey || '').split('-')[0];
  if (deps.assertAppEnvGate) {
    try { deps.assertAppEnvGate(端); }
    catch (e) { return fail(e, { stage: 'app_gate' }); }
  }

  // 4. 人审(A,必经):确认/修改脚本 + routeKey,才允许重放
  const review = await deps.reviewScript(script0);
  if (!review?.approved) return fail('人审未通过', { stage: 'review' });
  const script = review.script || script0;
  const routeKey = script.routeKey;

  // 4.5 定被测目标:先查项目记忆里的访问录(routeKey + featureMenu)。
  //   命中记忆 → 自动导航当前 tab 到记录 URL(复用登录会话);
  //   首次未命中 → 用当前打开的页当入口,重放跑完后沉淀 (routeKey,featureMenu)->当前URL;
  //   无当前页 → 手输 URL / PRD entryUrl 兜底;都没有 → 停(no_target)。
  const featureMenu = script.featureMenu || '';
  const remembered = deps.lookupSystem ? deps.lookupSystem(routeKey, featureMenu) : null;
  let target = null;
  let sediment = null; // 跑完要沉淀的 { routeKey, featureMenu, url }
  if (remembered?.url) {
    target = { tabId: deps.pinnedTab?.tabId || null, url: remembered.url, navigate: true, source: 'memory' };
  } else if (deps.pinnedTab?.tabId) {
    target = { tabId: deps.pinnedTab.tabId, url: deps.pinnedTab.url || '', navigate: false, source: 'current_tab' };
    if (featureMenu && deps.pinnedTab.url) sediment = { routeKey, featureMenu, url: deps.pinnedTab.url };
  } else if (deps.entryUrlOverride) {
    target = { url: deps.entryUrlOverride, navigate: true, source: 'override' };
  } else if (script.entryUrl) {
    target = { url: script.entryUrl, navigate: true, source: 'prd_entry_url' };
  }
  if (!target || (!target.tabId && !target.url)) return fail('no_target', { stage: 'entry' });
  // 建图(懒起浏览器 + 命中记忆则先导航 + 白名单校验)。白名单外/非法 URL 在此抛错停下。
  if (deps.prepareTarget) {
    let prep;
    try { prep = await deps.prepareTarget(target); }
    catch (e) { return fail(e, { stage: 'prepare' }); }
    // 落在登录页(会话过期)→ 暂停等用户登录,登完重试一次(仍在登录页也照跑,结果会是不确定)。
    if (prep?.isLogin && deps.onLoginRequired) {
      await deps.onLoginRequired(prep.url);
      try { await deps.prepareTarget(target, { pauseOnLogin: false }); }
      catch (e) { return fail(e, { stage: 'prepare' }); }
    }
  }

  // 5. 逐步重放(先白名单校验;写操作需确认;锚点失效 uncertain;无自愈)
  const stepResults = [];
  try {
    for (const step of script.steps || []) {
      const result = await deps.replayStep(step, {
        target, whitelist: deps.whitelist, rules: deps.rules,
        confirm: deps.confirm, safety: deps.safety,
      });
      // 6. 三态判定 + 证据
      const judged = deps.judge(step, result);
      const evidence = deps.buildEvidence(step, judged);
      stepResults.push({ step, result, judged, evidence });
    }
  } catch (e) {
    // 白名单外等致命错 → 整体停(不写脏结果)
    return fail(e, { stage: 'replay' });
  }

  // 6.5 首次沉淀:重放跑完(不管三态)→ 把这个功能菜单的入口记进访问录,下次自动导航。
  if (sediment && deps.recordSystem) {
    try { deps.recordSystem(sediment.routeKey, sediment.featureMenu, sediment.url); } catch {}
  }

  // 7. 汇总
  const judgedList = stepResults.map((x) => x.judged);
  const summary = deps.summarize
    ? deps.summarize(judgedList, script.requirementIds)
    : { total: judgedList.length };
  const durationMs = Date.now() - t0;

  // 8. 按 routeKey 路由到结果表 + 群
  const targets = await deps.resolveTargets(routeKey);
  if (!targets?.ok) return fail(targets?.reason || '路由解析失败', { stage: 'routing', summary });

  // 9. 写结果表(一条运行记录)+ 播报(含文档 URL = 透明)
  const recordId = await deps.writeRunRecord(targets.resultToken, targets.resultTableId, {
    用例: script.caseName || prdInput,
    AI判定: summary.pass && !summary.fail && !summary.uncertain ? '通过' : (summary.fail ? '失败' : '不确定'),
    耗时ms: String(durationMs),
    证据链接: targets.resultTableUrl,
    人工改判: '',
    脚本改动: review.edited ? '有' : '',
  });
  const text = [
    `【QA 结果播报】${routeKey}`,
    `通过 ${summary.pass ?? '?'} / 失败 ${summary.fail ?? '?'} / 不确定 ${summary.uncertain ?? '?'}｜覆盖率 ${summary.coverage ?? ''}｜耗时 ${durationMs}ms`,
    `结果表: ${targets.resultTableUrl}`,
    `路由总表: ${targets.routingUrl}`,
  ].join('\n');
  const messageId = await deps.broadcast(targets.chatId, text);

  return { ok: true, routeKey, summary, durationMs, recordId, messageId, stepResults };
}

export { runTask };
