// Task 0c spike(候选 B′):验证编排器能否 spawn headless `claude -p` 生成脚本 JSON。
// 复用本机已登录的 Claude CLI —— 不需要 API key,生成不需要浏览器工具。
// 用法:node host/qa/spikes/spike-model-access.mjs
import { spawn } from 'node:child_process';
import os from 'node:os';

const CLAUDE_BIN = process.env.CLAUDE_SIDEBAR_CLAUDE_BIN || 'claude';

// 一段样例 PRD(模拟 0a 用 SDK 读回的正文)。
const SAMPLE_PRD = [
  '需求:登录页',
  '- R1: 打开登录页,页面标题应为"登录"。',
  '- R2: 用户名输入框 placeholder 应为"请输入用户名"。',
  '- R3: 未输入密码点击登录,应提示"密码不能为空"。',
].join('\n');

const PROMPT = `你是测试脚本生成器。根据下面的 PRD,产出一个 JSON,描述只读断言步骤序列。
只输出 JSON,不要任何解释、不要 markdown 围栏、不要调用任何工具。
JSON 结构:
{
  "requirementIds": ["R1","R2","R3"],
  "steps": [
    {"action":"assert_text","target":"页面标题","expected":"登录","requirementId":"R1"}
  ]
}
每个 step 的 requirementId 必须属于 requirementIds。

PRD:
${SAMPLE_PRD}`;

function runClaude(prompt) {
  return new Promise((resolve) => {
    // --strict-mcp-config + 空 mcpServers:不加载任何 MCP,生成纯文本、不碰工具。
    const args = ['-p', '--output-format', 'json', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'];
    const child = spawn(CLAUDE_BIN, args, {
      cwd: os.tmpdir(), // 中性目录,避免加载本项目 CLAUDE.md
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const killer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 170000);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => { clearTimeout(killer); resolve({ code, out, err }); });
    child.on('error', (e) => { clearTimeout(killer); resolve({ code: -1, out, err: String(e) }); });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

// 从模型输出抽出 JSON(容忍 ```json 围栏 / 前后杂字)。
function extractJson(text) {
  if (!text) return null;
  const fenced = String(text).match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : String(text);
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  try { return JSON.parse(candidate.slice(start, end + 1)); } catch { return null; }
}

async function main() {
  console.log(`[0c] 用 CLI: ${CLAUDE_BIN};spawn headless 生成脚本…(可能 10-60s)`);
  const { code, out, err } = await runClaude(PROMPT);
  if (code !== 0) {
    console.log(`[0c] ❌ claude 退出码=${code}。stderr: ${err.slice(0, 400)}`);
    if (/log ?in|auth|unauthor|credential|token/i.test(err)) {
      console.log('[0c] ⚠️ 疑似未登录——请先在终端 `claude` 登录后重试。');
    }
    process.exitCode = 1;
    return;
  }
  // --output-format json 给单一结果对象,助手最终文本在 .result。
  let resultText = out;
  try {
    const obj = JSON.parse(out);
    resultText = obj.result ?? obj.text ?? out;
    console.log(`[0c] CLI 返回 type=${obj.type} is_error=${obj.is_error} duration=${obj.duration_ms}ms`);
  } catch {
    console.log('[0c] ⚠️ stdout 不是单一 JSON,按纯文本处理。');
  }
  const script = extractJson(resultText);
  if (!script) {
    console.log(`[0c] ❌ 无法从输出解析出 JSON 脚本。前 500 字:\n${String(resultText).slice(0, 500)}`);
    process.exitCode = 1;
    return;
  }
  const hasReqs = Array.isArray(script.requirementIds) && script.requirementIds.length > 0;
  const hasSteps = Array.isArray(script.steps) && script.steps.length > 0;
  const stepsValid =
    hasSteps &&
    script.steps.every((s) => s && s.requirementId && script.requirementIds.includes(s.requirementId));
  console.log(`[0c] ✅ 解析出脚本 JSON:`);
  console.log(`  requirementIds=${JSON.stringify(script.requirementIds)}`);
  console.log(`  steps 数=${script.steps?.length};首个=${JSON.stringify(script.steps?.[0])}`);
  console.log(
    `[0c] 结论: ${
      hasReqs && hasSteps && stepsValid
        ? '✅ B′ 成立——编排器 spawn headless claude 能拿回合法结构化脚本'
        : '⚠️ 结构不完整(reqs/steps/溯源有缺),需调 prompt'
    }`,
  );
}

main().catch((e) => {
  console.log(`[0c] 异常: ${e?.message || e}`);
  process.exitCode = 1;
});
