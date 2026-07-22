// 脚本生成器(Task 3,B′):把 PRD 文本 → 锚点化步骤序列 JSON。
// 用 0c 验过的招:spawn headless `claude -p` 生成,复用 CLI 登录态(无 API key)。
// 生成后用 validateScript 兜底,不合法重试一次,仍不合法标"脚本生成异常"。
// 打磨:① 产出 routeKey(从路由总表已有键里选)+ entryUrl(从 PRD 抽被测入口);
//       ② 用 stream-json 流式解析,生成期实时 emit 进度(消除"卡住"错觉)。
import { spawn } from 'node:child_process';
import os from 'node:os';
import { validateScript, READONLY_ACTIONS, WRITE_ACTIONS } from './script-schema.mjs';

const CLAUDE_BIN = process.env.CLAUDE_SIDEBAR_CLAUDE_BIN || 'claude';
const ALL_ACTIONS = [...READONLY_ACTIONS, ...WRITE_ACTIONS];

function buildPrompt(prd, { refs, routeKeys } = {}) {
  const prdText = typeof prd === 'string' ? prd : String(prd?.content || '');
  const mentions = refs?.mentions || prd?.refs?.mentions;
  const refNote = mentions?.length
    ? `\n注意:PRD 引用了其它文档 ${JSON.stringify(mentions.map((m) => m.title))},如需其内容请在步骤里标注,不要编造。`
    : '';
  const keyList = Array.isArray(routeKeys) ? routeKeys.filter(Boolean) : [];
  const routeNote = keyList.length
    ? `\nrouteKey 从以下已有路由键里选最匹配的一个:${JSON.stringify(keyList)};都不匹配就按「端-系统模块」格式**新拟一个**(如 "运营后台-VIP配置"),不要填 "待人工"。`
    : `\nrouteKey 按「端-系统模块」格式填(如 "运营后台-VIP配置"),从 PRD 推断被测端与模块,不要填 "待人工"。`;
  return `你是测试脚本生成器。根据下面的 PRD,产出一个 JSON 描述只读断言步骤序列。
只输出 JSON,不要任何解释、不要 markdown 围栏、不要调用任何工具。
结构:
{
  "requirementIds": ["从 PRD 抽出的全部需求 ID"],
  "routeKey": "<路由键,见下方说明>",
  "featureMenu": "<被测功能在后台的菜单路径,如「系统配置 > VIP配置」;从 PRD 推断,单页应用可留空>",
  "entryUrl": "<可选:仅当 PRD 原文明确写了被测入口 URL 时填,否则留空字符串 \\"\\">",
  "steps": [
    {"action":"<动作>","target":"<定位对象:锚点或文本>","expected":"<期望>","requirementId":"<必属于 requirementIds>"}
  ]
}
action 只能是:${ALL_ACTIONS.join(' / ')}
每个 step 的 requirementId 必须属于 requirementIds。只读优先,写操作(点击/提交等)尽量避免。${routeNote}
entryUrl 默认留空即可 —— 测试会针对用户当前打开的页面跑;只有 PRD 原文真写了被测地址才填,绝不要编造。${refNote}

PRD:
${prdText}`;
}

// 跑一次 headless claude,stream-json 流式解析。返回 { code, resultText, err }。
// onProgress(label) 在生成过程中被周期调用(心跳 + 增量字数),消除"卡住"错觉。
function runClaude(prompt, { timeoutMs = 170000, onProgress } = {}) {
  return new Promise((resolve) => {
    const args = [
      '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    ];
    const child = spawn(CLAUDE_BIN, args, { cwd: os.tmpdir(), env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '';
    let err = '';
    let resultText = '';
    let charCount = 0;
    let lastTick = 0;
    const started = Date.now();
    const emit = (label) => { try { onProgress?.(label); } catch {} };
    // 心跳:哪怕没有增量事件,也每几秒报一次已耗时,证明还活着。
    const heartbeat = setInterval(() => emit(`生成脚本中…(已 ${Math.round((Date.now() - started) / 1000)}s)`), 4000);
    const killer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, timeoutMs);

    function handleLine(line) {
      const s = line.trim();
      if (!s) return;
      let ev;
      try { ev = JSON.parse(s); } catch { return; }
      if (ev.type === 'system' && ev.subtype === 'init') { emit('已连接模型,开始生成脚本…'); return; }
      if (ev.type === 'stream_event') {
        const d = ev.event?.delta;
        if (d?.type === 'text_delta' && typeof d.text === 'string') {
          charCount += d.text.length;
          if (charCount - lastTick >= 400) { lastTick = charCount; emit(`生成脚本中… 已产出约 ${charCount} 字`); }
        }
        return;
      }
      if (ev.type === 'result') {
        if (typeof ev.result === 'string') resultText = ev.result;
        return;
      }
      // 兜底:未开启 partial 时,assistant 完整消息里取文本。
      if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
        const txt = ev.message.content.filter((c) => c.type === 'text').map((c) => c.text).join('');
        if (txt) resultText = txt;
      }
    }

    function done(payload) { clearInterval(heartbeat); clearTimeout(killer); resolve(payload); }

    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        handleLine(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    });
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => { if (buf.trim()) handleLine(buf); emit('解析脚本…'); done({ code, resultText, err }); });
    child.on('error', (e) => done({ code: -1, resultText: '', err: String(e) }));
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
async function generateOnce(prompt, { onProgress } = {}) {
  const { code, resultText } = await runClaude(prompt, { onProgress });
  if (code !== 0) return null;
  return extractJson(resultText);
}

// 主入口:生成 + 校验 + 重试一次。
// opts: { routeKeys?, entryUrlOverride?, onProgress?, refs? }
// entryUrlOverride:命令行/侧栏手输的被测页 URL,PRD 没抽到时兜底。
// 返回 { ok, script } 或 { ok:false, error, reason?, script? }。
async function generate(prd, opts = {}) {
  const { routeKeys, entryUrlOverride, onProgress } = opts;
  const prompt = buildPrompt(prd, { refs: opts.refs, routeKeys });
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const script = await generateOnce(prompt, { onProgress });
    if (script) {
      // PRD 没抽到 entryUrl 但有手输覆盖 → 盖上去再校验。
      if (entryUrlOverride && (typeof script.entryUrl !== 'string' || !script.entryUrl.trim())) {
        script.entryUrl = entryUrlOverride;
      }
      const v = validateScript(script);
      if (v.ok) return { ok: true, script, attempts: attempt };
      // 不合法:重试一次(仍不合法则把校验错误带回)。
      if (attempt === 1) continue;
      return { ok: false, error: '脚本生成异常', reason: v.errors, script, attempts: attempt };
    }
    if (attempt === 2) return { ok: false, error: '脚本生成异常', reason: ['未解析出 JSON'], attempts: attempt };
  }
  return { ok: false, error: '脚本生成异常', attempts: 2 };
}

export { generate, buildPrompt, extractJson };
