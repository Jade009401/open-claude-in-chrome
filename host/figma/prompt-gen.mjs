// 由压缩后的 Figma 设计(+ 可选组件库信息)拼装前端开发提示词(纯模板,不调模型)。
// 组件库信息由调用方注入(子 agent 定位后接上);缺失时退化为"扫目标仓库 src/components 复用"。

// 把压缩设计树走成可读的还原大纲。
function walkSpec(node, depth, lines) {
  if (!node) return;
  const ind = '  '.repeat(depth);
  const rep = node.repeat ? ` ×${node.repeat}(示样1条)` : '';
  const box = node.box ? ` [${node.box.w}×${node.box.h}${depth > 0 ? ` @${node.box.x},${node.box.y}` : ''}]` : '';
  if (node.type === 'ICON') { // 图标降噪:只报一个 icon 叶子
    lines.push(`${ind}▸ icon:${node.name || ''}${box}${rep}`);
    return;
  }
  if (node.type === 'TEXT') {
    const font = node.font ? ` ${node.font.size}px${node.font.weight ? `/${node.font.weight}` : ''}` : '';
    const color = node.color ? ` ${node.color}` : '';
    lines.push(`${ind}• 文字「${String(node.text || '').replace(/\s+/g, ' ').trim()}」${font}${color}${box}${rep}`);
    return;
  }
  const comp = node.component ? ` 〔组件:${node.component}〕` : '';
  const layout = node.layout ? ` {${node.layout.dir} gap${node.layout.gap} pad[${node.layout.pad.join(',')}]${node.layout.align ? ` align=${node.layout.align}` : ''}}` : '';
  const fill = node.fill ? ` fill=${node.fill}` : '';
  const radius = node.radius ? ` r=${node.radius}` : '';
  const img = node.image ? ` 【图片${node.imageUrl ? `:${node.imageUrl}` : ''}】` : '';
  lines.push(`${ind}▸ ${node.name || node.type}${comp}${layout}${fill}${radius}${img}${box}${rep}`);
  (node.children || []).forEach((c) => walkSpec(c, depth + 1, lines));
}

// buildDevPrompt({ design, componentList, pageName?, stack?, componentLib? }) → 提示词字符串。
//   componentLib?: { location, importConvention, components:[{name,usage}] }(找到组件库后注入)
function buildDevPrompt({ design, componentList = [], palette = [], pageName, stack, componentLib } = {}) {
  const name = pageName || design?.name || '页面';
  const specLines = [];
  walkSpec(design, 0, specLines);
  const paletteSection = palette.length ? `\n## 用色(调色板,节点上的 fill/color 即引用)\n${palette.join('  ')}` : '';

  const compSection = componentLib
    ? [
      '## 使用项目组件(不要用通用 HTML / 第三方原生组件)',
      `组件库:${componentLib.location}`,
      `导入约定:${componentLib.importConvention}`,
      '可用组件(优先复用):',
      ...(componentLib.components || []).map((c) => `- ${c.name}${c.usage ? ` — ${c.usage}` : ''}`),
    ].join('\n')
    : [
      '## 使用项目组件(不要用通用 HTML / 第三方原生组件)',
      '(组件库位置待确认)动手前先扫目标仓库 `src/components` 复用已有组件;',
      '设计里出现的组件实例见下方〔组件〕标注,一一映射到项目对应组件。',
    ].join('\n');

  const figmaComps = componentList.length ? `\n设计中用到的 Figma 组件:${componentList.join('、')}` : '';
  const stackSection = stack || '(目标仓库 / 技术栈待确认:动手前先定 框架 / UI 库 / 样式方案 / 请求封装 / i18n)';

  return [
    `你是资深前端工程师。请根据下面这份 Figma 设计,开发【${name}】。`,
    '',
    `## 技术栈 / 目标仓库\n${stackSection}`,
    '',
    compSection + figmaComps,
    paletteSection,
    '',
    '## 设计还原(来自 Figma,单位 px;〔组件〕=用项目对应组件替换;×N=同款重复只列示样)',
    specLines.join('\n'),
    '',
    '## 要求',
    '- 严格按尺寸 / 间距 / 颜色还原;auto-layout 的 gap/padding 用 flex 实现。',
    '- 所有可复用元素用项目组件,不手写通用标签。',
    '- 文案先按设计写死;需要 i18n / 接口的地方标 TODO 待确认。',
    '- 交互(点击 / tab / 弹窗)按设计推断实现,拿不准的标 TODO,不臆造。',
  ].join('\n');
}

// 加载模式:把设计作为"上下文"注入开发会话——先别动手,以当前仓库(cwd)的组件库为准。
function buildLoadContext({ design, componentList = [], palette = [], pageName } = {}) {
  const name = pageName || design?.name || '页面';
  const specLines = [];
  walkSpec(design, 0, specLines);
  const paletteLine = palette.length ? `\n用色:${palette.join('  ')}` : '';
  const figmaComps = componentList.length ? `\nFigma 组件名(作映射线索):${componentList.join('、')}` : '';
  return [
    `【已加载 Figma 设计:${name}】以下是设计上下文,先记住。`,
    '**先别动手写代码**,等我明确说「开发这个页面 / 把 X 改成 Y / 调样式」再做。',
    '开发时:用**当前仓库(你所在的 cwd)**的组件库 —— 先扫 `src/components` 与 `package.json` 确认可用组件与技术栈,再据此实现;下方 Figma 组件名作映射线索;严格按尺寸/间距/颜色还原,auto-layout 的 gap/padding 用 flex。',
    figmaComps + paletteLine,
    '',
    '## 设计还原(px;〔组件〕=用当前仓库对应组件;×N=同款只列示样)',
    specLines.join('\n'),
  ].join('\n');
}

export { buildDevPrompt, walkSpec, buildLoadContext };
