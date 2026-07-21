// 侧栏 /figma 命令:抓当前 Figma tab(=选中那屏)→ REST 读设计 → 把设计"加载"进当前开发会话。
// 加载模式(不自动开发):设计作为上下文注入会话,用户随后驱动"开发/调样式";cwd 不绑定,
// 非前端仓库先跟用户确认。触发/pageContext/注入(enqueueChat)由 chat-native-host 提供。
import fs from 'node:fs';
import path from 'node:path';
import { readDesign, parseFigmaUrl } from './figma-client.mjs';
import { buildLoadContext } from './prompt-gen.mjs';

function isFigmaCommand(text) {
  return /^\/figma(\s|$)/.test(String(text || '').trim());
}
// /figma [页面名] [--images] —— 页面名可选(否则用画板名);--images 才取渲染图(限流严,默认不取)。
function parseFigmaCommand(text) {
  const rest = String(text || '').trim().replace(/^\/figma\s*/, '').trim();
  const withImages = /(^|\s)--images(\s|$)/.test(rest);
  const pageName = rest.replace(/--images/g, '').trim() || null;
  return { pageName, withImages };
}

// —— 前端仓库判定:cwd 有含前端依赖的 package.json,或有 src/components ——
const FE_DEPS = /"(vue|nuxt|react|vite|@vue\/|svelte|@angular\/|webpack|element-ui|element-plus|vant|ant-design-vue)"/i;
function isFrontendRepo(cwd) {
  if (!cwd) return false;
  try { if (FE_DEPS.test(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'))) return true; } catch {}
  try { return fs.statSync(path.join(cwd, 'src', 'components')).isDirectory(); } catch {}
  return false;
}

// —— pending:等用户回复前端仓库路径(下一条侧栏消息作为回答)——
let pendingResolve = null;
function hasPending() { return Boolean(pendingResolve); }
function answer(text) {
  if (!pendingResolve) return false;
  const r = pendingResolve;
  pendingResolve = null;
  r(String(text || '').trim());
  return true;
}
function awaitReply() { return new Promise((resolve) => { pendingResolve = resolve; }); }

// 主入口:emit = { status, message, done };pageContext = 当前页;deps = { cwd, inject(repo, prompt) }。
async function runFigmaInSidebar(text, emit, pageContext = null, { cwd = '', inject } = {}) {
  const url = pageContext?.url || '';
  const { fileKey, nodeId } = parseFigmaUrl(url);
  if (!/figma\.com/i.test(url) || !fileKey || !nodeId) {
    emit.message('请先在 Figma 里打开并**选中**要开发的那一屏(选中后地址栏带 node-id),再在这个 Figma 标签页发 /figma。');
    emit.done();
    return;
  }
  try {
    const { pageName, withImages } = parseFigmaCommand(text);
    emit.status(`Figma:读取设计 ${nodeId} …`);
    const { design, componentList, palette } = await readDesign(url, { withImages });

    // 校验开发目标仓库(cwd)。不是前端仓库 → 暂停问用户要路径。
    let repo = cwd;
    if (!isFrontendRepo(repo)) {
      emit.message(`没检测到前端仓库(当前 cwd:${repo || '未设'})。\n请回复要开发的**前端仓库绝对路径**(或先在侧栏设置里把 cwd 设到该仓库再重发 /figma)。`);
      repo = await awaitReply();
      if (!isFrontendRepo(repo)) {
        emit.message(`「${repo}」不像前端仓库(没找到含前端依赖的 package.json 或 src/components)。已中止;设好仓库后重发 /figma。`);
        emit.done();
        return;
      }
    }

    emit.status('Figma:把设计加载进会话…');
    const context = buildLoadContext({ design, componentList, palette, pageName });
    if (inject) {
      inject(repo, context);
      emit.message(`✅ 已加载设计【${pageName || design?.name || '页面'}】到会话(开发目录:${repo})。\n现在直接说:"开发这个页面 / 先讲结构 / 把某块改成…" —— 我会在该仓库里动手。`);
    } else {
      emit.message(`\`\`\`\n${context}\n\`\`\``); // 无注入能力时退回回显
    }
  } catch (e) {
    const raw = String(e?.message || e);
    const msg = /429|rate limit/i.test(raw)
      ? 'Figma 限流了(429)——已自动等待重试仍未过。请过几分钟再发 /figma;图片渲染默认已关(降流),同一屏 10 分钟内会走缓存不再打接口。'
      : raw;
    emit.message(`Figma 读取/加载失败:${msg}`);
  } finally {
    emit.done();
  }
}

export { isFigmaCommand, parseFigmaCommand, isFrontendRepo, hasPending, answer, runFigmaInSidebar };
