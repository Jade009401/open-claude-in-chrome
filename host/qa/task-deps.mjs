// 组装 runTask 的真实依赖(run-task 命令行 与 侧栏 /qa 命令 共用)。
// 差异化的 reviewScript(人审)/ confirm(写操作确认)由调用方传入(终端 or 侧栏)。
import { readDoc, writeRunRecord, broadcast } from './lark-client.mjs';
import { generate } from './script-gen.mjs';
import { replayStep } from './replayer.mjs';
import { judge, buildEvidence } from './verdict.mjs';
import { summarize } from './report.mjs';
import { resolveTargets } from './routing.mjs';
import * as safety from './safety.mjs';
import { assertAppEnvGate } from './app-gate.mjs';

// buildRealDeps({ client, cfg, targetUrl, bc, reviewScript, confirm }) → runTask 的 deps。
//   client   飞书 SDK client
//   cfg      loadQaConfig() 结果(envWhitelist/writeKeywords/writeActions)
//   targetUrl 被测页 URL(无则跳过浏览器重放)
//   bc       BrowserClient(已连);无 targetUrl 时可为 null
//   reviewScript(script) → { approved, script, edited? }
//   confirm(step) → boolean(写操作二次确认)
function buildRealDeps({ client, cfg, targetUrl, bc, reviewScript, confirm }) {
  return {
    url: targetUrl,
    whitelist: cfg.envWhitelist,
    rules: cfg,
    readDoc: (u) => readDoc(u, { client }),
    generate: (prd) => generate(prd),
    reviewScript,
    replayStep: (step) => replayStep(step, {
      url: targetUrl,
      whitelist: cfg.envWhitelist,
      rules: cfg,
      safety,
      locate: async ({ query }) => bc.locate({ query, pageQuery: targetUrl, limit: 5 }),
      read: async (anchor) => bc.read({ id: anchor.id, pageQuery: targetUrl }),
      act: async (anchor, s) => bc.act({ id: anchor.id, action: s.action, value: s.value, confirmed: true, pageQuery: targetUrl }),
      confirm,
    }),
    judge,
    buildEvidence,
    summarize,
    assertAppEnvGate: (端) => assertAppEnvGate(端),
    resolveTargets: (routeKey) => resolveTargets(client, routeKey),
    writeRunRecord: (token, tableId, fields) => writeRunRecord(client, token, tableId, fields),
    broadcast: (chatId, text) => broadcast(client, chatId, text),
  };
}

export { buildRealDeps };
