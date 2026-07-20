#!/usr/bin/env node
// Task 7 触发层 A(最简单):命令行入口。
// 用法: node host/qa/run-task.mjs <PRD链接> [被测页URL]
//   <PRD链接>   飞书 PRD 文档链接(读需求、生成脚本)
//   [被测页URL] 被测页面入口(白名单内)。给了才做浏览器重放;不给则只走"读→生成→人审"。
// 前置:被测页在 Chrome 打开、mcp-server primary 在跑(侧栏会话在,或自持)。
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { createClient } from './lark-client.mjs';
import { runTask } from './orchestrator.mjs';
import { loadQaConfig } from './config.mjs';
import { BrowserClient } from './browser-client.mjs';
import { buildRealDeps } from './task-deps.mjs';

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

  const deps = buildRealDeps({
    client, cfg, targetUrl, bc,
    // 人审(A):终端打印脚本 + y/n。
    reviewScript: async (script) => {
      console.log('\n===== 待人审脚本 =====');
      console.log('routeKey:', script.routeKey);
      console.log('需求:', JSON.stringify(script.requirementIds));
      (script.steps || []).forEach((s, i) => console.log(`  ${i + 1}. [${s.action}] ${s.target} 期望=${s.expected} (${s.requirementId})`));
      const a = await ask('确认执行? (y=确认 / n=否决): ');
      return { approved: a === 'y', script };
    },
    // 写操作终端二次确认(不自传 confirmed)。
    confirm: async (s) => (await ask(`⚠️ 写操作 [${s.action} ${s.target}] 确认执行? (y/n): `)) === 'y',
  });

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
