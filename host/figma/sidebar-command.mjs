// 侧栏 /figma 命令:抓当前 Figma tab(= 你选中那屏的 node-id)→ REST 读设计 → 生成前端提示词 → 回显。
// 触发/pageContext 由 chat-native-host 提供(和 /qa 同一套当前页机制)。
import { readDesign, parseFigmaUrl } from './figma-client.mjs';
import { buildDevPrompt } from './prompt-gen.mjs';
import { exchangeWebNuxt, stackText } from './component-lib.mjs';

function isFigmaCommand(text) {
  return /^\/figma(\s|$)/.test(String(text || '').trim());
}
// /figma [页面名] —— 可选传个页面名(如 tradfi-activity),否则用画板名兜底。
function parseFigmaCommand(text) {
  const rest = String(text || '').trim().replace(/^\/figma\s*/, '').trim();
  return { pageName: rest || null };
}

// emit = { status(label), message(text), done() }。pageContext = { tabId, url, title }(当前打开/选中的页)。
async function runFigmaInSidebar(text, emit, pageContext = null) {
  const url = pageContext?.url || '';
  const { fileKey, nodeId } = parseFigmaUrl(url);
  if (!/figma\.com/i.test(url) || !fileKey || !nodeId) {
    emit.message('请先在 Figma 里打开并**选中**要开发的那一屏(选中后地址栏会带上它的 node-id),然后在这个 Figma 标签页发 /figma。');
    emit.done();
    return;
  }
  try {
    const { pageName } = parseFigmaCommand(text);
    emit.status(`Figma:读取设计 ${nodeId} …`);
    const { design, componentList, palette } = await readDesign(url);
    emit.status('Figma:生成前端提示词…');
    // 映射到主站 exchange-web-nuxt 组件库(用项目真实组件,不写通用 HTML)。
    const prompt = buildDevPrompt({ design, componentList, palette, pageName, componentLib: exchangeWebNuxt, stack: stackText });
    emit.message(`\`\`\`\n${prompt}\n\`\`\``);
  } catch (e) {
    emit.message(`Figma 读取/生成失败:${e?.message || e}(检查在 Figma 标签页触发、已选中某屏、FIGMA_TOKEN 有该文件权限)`);
  } finally {
    emit.done();
  }
}

export { isFigmaCommand, runFigmaInSidebar };
