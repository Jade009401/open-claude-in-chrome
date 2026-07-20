// QA 编排器(Task 7):把各模块串成一次任务。触发无关 —— runTask(prdInput, deps)。
// 依赖全注入,便于测试;真实接线(飞书/浏览器/claude)由触发层组装 deps 后调用。
//
// 链路:读PRD → (routeKey 若原生App 过环境门槛) → 生成脚本 → 人审(A,必经) →
//       逐步重放(先白名单校验、写操作需确认) → 三态判定+证据 → 汇总 →
//       按 routeKey 路由 → 写结果表 + 播报(含文档URL,透明)。
//
// deps: {
//   readDoc(prdInput), generate(prd), reviewScript(script),
//   replayStep(step, stepDeps), judge(step,result), buildEvidence(step,judged),
//   resolveTargets(routeKey), writeRunRecord(token,tableId,fields), broadcast(chatId,text),
//   assertUrlAllowed(url,whitelist)? , assertAppEnvGate(端)? ,
//   url, whitelist, rules, confirm, locate, act,
// }

function fail(reason, extra = {}) {
  return { ok: false, reason: typeof reason === 'string' ? reason : reason?.code, error: reason, ...extra };
}

async function runTask(prdInput, deps = {}) {
  const t0 = Date.now();
  // 1. 读 PRD
  const prd = await deps.readDoc(prdInput);

  // 2. 生成脚本(headless claude,B′)
  const gen = await deps.generate(prd);
  if (!gen?.ok) return fail(gen?.error || '脚本生成异常', { stage: 'generate' });
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

  // 5. 逐步重放(先白名单校验;写操作需确认;锚点失效 uncertain;无自愈)
  const stepResults = [];
  try {
    for (const step of script.steps || []) {
      const result = await deps.replayStep(step, {
        url: deps.url, whitelist: deps.whitelist, rules: deps.rules,
        locate: deps.locate, act: deps.act, confirm: deps.confirm, safety: deps.safety,
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
