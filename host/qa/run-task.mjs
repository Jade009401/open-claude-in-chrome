#!/usr/bin/env node
// Task 7 触发层 A(最简单):命令行入口。
// 用法: node host/qa/run-task.mjs <PRD链接> [被测页URL]
//   <PRD链接>   飞书 PRD 文档链接(读需求、生成脚本)
//   [被测页URL] 被测页面入口(白名单内)。给了才做浏览器重放;不给则只走"读→生成→人审"。
// 前置:被测页在 Chrome 打开、mcp-server primary 在跑(侧栏会话在,或自持)。
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { createClient, readDoc, writeRunRecord, broadcast } from './lark-client.mjs';
import { generate } from './script-gen.mjs';
import { replayStep } from './replayer.mjs';
import { judge, buildEvidence } from './verdict.mjs';
import { summarize } from './report.mjs';
import { resolveTargets } from './routing.mjs';
import { runTask } from './orchestrator.mjs';
import * as safety from './safety.mjs';
import { assertAppEnvGate } from './app-gate.mjs';
import { loadQaConfig } from './config.mjs';
import { BrowserClient } from './browser-client.mjs';

async function main() {
  const prdUrl = process.argv[2];
  const targetUrl = process.argv[3] || null;
  if (!prdUrl) {
    console.log('用法: node host/qa/run-task.mjs <PRD链接> [被测页URL]');
    process.exit(1);
  }
  const cfg = loadQaConfig();
  const client = createClient();
  const rl = readline.createInterface({ input, output });
  const ask = async (q) => (await rl.question(q)).trim().toLowerCase();

  // 浏览器客户端:仅在给了被测页 URL 时连接 + 建图(replay 需要)。
  let bc = null;
  if (targetUrl) {
    bc = new BrowserClient();
    console.log(`[run] 连接浏览器通道…`);
    await bc.connect();
    console.log(`[run] 建图 ${targetUrl} …`);
    await bc.map({ pageQuery: targetUrl });
  }

  const deps = {
    url: targetUrl,
    whitelist: cfg.envWhitelist,
    rules: cfg,
    readDoc: (u) => readDoc(u, { client }),
    generate: (prd) => generate(prd),
    // 人审(A):打印脚本 + routeKey,终端确认。
    reviewScript: async (script) => {
      console.log('\n===== 待人审脚本 =====');
      console.log('routeKey:', script.routeKey);
      console.log('需求:', JSON.stringify(script.requirementIds));
      (script.steps || []).forEach((s, i) => console.log(`  ${i + 1}. [${s.action}] ${s.target} 期望=${s.expected} (${s.requirementId})`));
      const a = await ask('确认执行? (y=确认 / n=否决): ');
      return { approved: a === 'y', script };
    },
    // 重放:locate/read/act 走浏览器客户端;写操作终端二次确认(不自传 confirmed)。
    replayStep: (step) => replayStep(step, {
      url: targetUrl,
      whitelist: cfg.envWhitelist,
      rules: cfg,
      safety,
      locate: async ({ query }) => bc.locate({ query, pageQuery: targetUrl, limit: 5 }),
      read: async (anchor) => bc.read({ id: anchor.id, pageQuery: targetUrl }),
      act: async (anchor, s) => bc.act({ id: anchor.id, action: s.action, value: s.value, confirmed: true, pageQuery: targetUrl }),
      confirm: async (s) => (await ask(`⚠️ 写操作 [${s.action} ${s.target}] 确认执行? (y/n): `)) === 'y',
    }),
    judge,
    buildEvidence,
    summarize,
    assertAppEnvGate: (端) => assertAppEnvGate(端),
    resolveTargets: (routeKey) => resolveTargets(client, routeKey),
    writeRunRecord: (token, tableId, fields) => writeRunRecord(client, token, tableId, fields),
    broadcast: (chatId, text) => broadcast(client, chatId, text),
  };

  try {
    const r = await runTask(prdUrl, deps);
    console.log('\n===== 结果 =====');
    console.log(JSON.stringify({ ok: r.ok, routeKey: r.routeKey, summary: r.summary, durationMs: r.durationMs, recordId: r.recordId, messageId: r.messageId, reason: r.reason }, null, 2));
  } finally {
    rl.close();
    bc?.close();
  }
}

main().catch((e) => {
  console.log('[run] 异常:', e?.message || e);
  process.exitCode = 1;
});
