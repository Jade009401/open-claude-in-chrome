#!/usr/bin/env node
// 用法: node host/figma/read-design.mjs "<figma链接>" [输出文件]
// 读节点子树 → host 侧压缩 → 打印/写出精简结构化摘要(供生成开发提示词;原始 JSON 不落地不进模型)。
// 前置: host/figma/.env.local 里配好 FIGMA_TOKEN。
import { writeFileSync } from 'node:fs';
import { readDesign } from './figma-client.mjs';

async function main() {
  const url = process.argv[2];
  const outFile = process.argv[3] || null;
  if (!url) { console.log('用法: node host/figma/read-design.mjs "<figma链接>" [输出文件]'); process.exit(1); }
  const result = await readDesign(url);
  const json = JSON.stringify(result, null, 2);
  if (outFile) { writeFileSync(outFile, json); console.log(`已写: ${outFile}（${Math.round(json.length / 1024)} KB）`); }
  else console.log(json);
  console.log(`\n[figma] file=${result.fileKey} node=${result.nodeId} 组件 ${result.componentList.length} 个 摘要 ${Math.round(json.length / 1024)}KB`);
}

main().catch((e) => { console.log('[figma] 异常:', e?.message || e); process.exitCode = 1; });
