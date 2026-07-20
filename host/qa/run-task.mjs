#!/usr/bin/env node
// Task 7 触发层 A(最简单):命令行入口。
// 用法: node host/qa/run-task.mjs <PRD链接> [被测页URL]
//   <PRD链接>   飞书 PRD 文档链接(读需求、生成脚本;被测入口默认从 PRD 抽)
//   [被测页URL] 可选兜底:PRD 没写被测入口 URL 时用它顶上(白名单内)
// 前置:被测页在 Chrome 打开、mcp-server primary 在跑(侧栏会话在,或自持)。
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { createClient } from './lark-client.mjs';
import { runTask } from './orchestrator.mjs';
import { loadQaConfig } from './config.mjs';
import { BrowserClient } from './browser-client.mjs';
import { buildRealDeps } from './task-deps.mjs';
import { stageLabel, humanizeError } from './sidebar-command.mjs';
import { formatRunResult } from './report.mjs';

async function main() {
  const prdUrl = process.argv[2];
  const targetUrl = process.argv[3] || null;
  if (!prdUrl) {
    console.log('用法: node host/qa/run-task.mjs <PRD链接> [被测页URL(可选,PRD 没写入口时兜底)]');
    process.exit(1);
  }
  const cfg = loadQaConfig();
  const client = createClient();
  const rl = readline.createInterface({ input, output });
  const ask = async (q) => (await rl.question(q)).trim().toLowerCase();

  // 浏览器懒起:拿到 entryUrl 要建图时才连(CLI 假设 primary 已在跑)。
  const connectBrowser = async () => {
    console.log('[run] 连接浏览器通道…');
    const bc = new BrowserClient();
    await bc.connect();
    return bc;
  };

  const deps = buildRealDeps({
    client, cfg,
    connectBrowser,
    entryUrlOverride: targetUrl,
    onProgress: (label) => console.log(`[run] ${label}`),
    // 人审(A):终端打印脚本 + y/n。
    reviewScript: async (script) => {
      console.log('\n===== 待人审脚本 =====');
      console.log('routeKey:', script.routeKey);
      console.log('被测入口:', script.entryUrl || '(未标明,将中止)');
      console.log('需求:', JSON.stringify(script.requirementIds));
      (script.steps || []).forEach((s, i) => console.log(`  ${i + 1}. [${s.action}] ${s.target} 期望=${s.expected} (${s.requirementId})`));
      const a = await ask('确认执行? (y=确认 / n=否决): ');
      return { approved: a === 'y', script };
    },
    // 写操作终端二次确认(不自传 confirmed)。
    confirm: async (s) => (await ask(`⚠️ 写操作 [${s.action} ${s.target}] 确认执行? (y/n): `)) === 'y',
    // 落到登录页 → 终端提示登录后回车继续。
    onLoginRequired: async (url) => { await ask(`🔐 落在登录页 ${url};请在浏览器登录后回车继续…`); },
  });

  try {
    const r = await runTask(prdUrl, deps);
    console.log('\n===== 结果 =====');
    if (r.ok) {
      console.log(formatRunResult(r));
    } else {
      console.log(`⛔ 没跑完(${stageLabel(r.stage)}):${humanizeError(r)}`);
    }
  } finally {
    rl.close();
    deps.closeBrowser();
  }
}

main().catch((e) => {
  console.log('[run] 异常:', e?.message || e);
  process.exitCode = 1;
});
