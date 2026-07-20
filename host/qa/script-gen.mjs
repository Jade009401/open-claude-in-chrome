// 脚本生成器(Task 3,B′):把 PRD 文本 → 锚点化步骤序列 JSON。
// 用 0c 验过的招:spawn headless `claude -p` 生成,复用 CLI 登录态(无 API key)。
// 生成后用 validateScript 兜底,不合法重试一次,仍不合法标"脚本生成异常"。
import { spawn } from 'node:child_process';
import os from 'node:os';
import { validateScript, READONLY_ACTIONS, WRITE_ACTIONS } from './script-schema.mjs';

const CLAUDE_BIN = process.env.CLAUDE_SIDEBAR_CLAUDE_BIN || 'claude';
const ALL_ACTIONS = [...READONLY_ACTIONS, ...WRITE_ACTIONS];

function buildPrompt(prd, { refs } = {}) {
  const prdText = typeof prd === 'string' ? prd : String(prd?.content || '');
  const refNote = refs?.mentions?.length
    ? `\n注意:PRD 引用了其它文档 ${JSON.stringify(refs.mentions.map((m) => m.title))},如需其内容请在步骤里标注,不要编造。`
    : '';
  return `你是测试脚本生成器。根据下面的 PRD,产出一个 JSON 描述只读断言步骤序列。
只输出 JSON,不要任何解释、不要 markdown 围栏、不要调用任何工具。
结构:
{
  "requirementIds": ["从 PRD 抽出的全部需求 ID"],
  "steps": [
    {"action":"<动作>","target":"<定位对象:锚点或文本>","expected":"<期望>","requirementId":"<必属于 requirementIds>"}
  ]
}
action 只能是:${ALL_ACTIONS.join(' / ')}
每个 step 的 requirementId 必须属于 requirementIds。只读优先,写操作(点击/提交等)尽量避免。${refNote}

PRD:
${prdText}`;
}

function runClaude(prompt, { timeoutMs = 170000 } = {}) {
  return new Promise((resolve) => {
    const args = ['-p', '--output-format', 'json', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'];
    const child = spawn(CLAUDE_BIN, args, { cwd: os.tmpdir(), env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const killer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => { clearTimeout(killer); resolve({ code, out, err }); });
    child.on('error', (e) => { clearTimeout(killer); resolve({ code: -1, out, err: String(e) }); });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

function extractJson(text) {
  if (!text) return null;
  const fenced = String(text).match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : String(text);
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  try { return JSON.parse(candidate.slice(start, end + 1)); } catch { return null; }
}

// 跑一次生成,返回解析出的脚本对象(或 null)。
async function generateOnce(prompt) {
  const { code, out } = await runClaude(prompt);
  if (code !== 0) return null;
  let resultText = out;
  try { resultText = JSON.parse(out).result ?? out; } catch {}
  return extractJson(resultText);
}

// 主入口:生成 + 校验 + 重试一次。返回 { ok, script } 或 { ok:false, error, script? }。
async function generate(prd, opts = {}) {
  const prompt = buildPrompt(prd, opts);
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const script = await generateOnce(prompt);
    if (script) {
      const v = validateScript(script);
      if (v.ok) return { ok: true, script, attempts: attempt };
      // 不合法:重试一次(把校验错误反馈进重试 prompt 提高成功率)
      if (attempt === 1) continue;
      return { ok: false, error: '脚本生成异常', reason: v.errors, script, attempts: attempt };
    }
    if (attempt === 2) return { ok: false, error: '脚本生成异常', reason: ['未解析出 JSON'], attempts: attempt };
  }
  return { ok: false, error: '脚本生成异常', attempts: 2 };
}

export { generate, buildPrompt, extractJson };
