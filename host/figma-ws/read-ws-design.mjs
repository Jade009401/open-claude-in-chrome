// CLI(验证用):node read-ws-design.mjs <figma-frames.json> <node-id> [页面名]
//   → 打印按 node-id 抽出的去噪设计大纲(= 会加载进会话的上下文)+ 统计。
import fs from 'node:fs';
import { readWsDesignFromBundle } from './ws-design.mjs';
import { buildLoadContext } from '../figma/prompt-gen.mjs';

const [, , bundlePath, nodeId, pageName] = process.argv;
if (!bundlePath || !nodeId) {
  console.error('用法: node read-ws-design.mjs <figma-frames.json> <node-id 如 149106-66368> [页面名]');
  process.exit(1);
}
const bundle = JSON.parse(fs.readFileSync(bundlePath, 'utf8'));
const { design, palette, componentList, nodeCount, rootKey } = readWsDesignFromBundle(bundle, nodeId);

console.error(`node-id ${nodeId} → guid ${rootKey} | 压缩后 ${nodeCount} 节点 | 组件 ${componentList.length} | 用色 ${palette.length}`);
console.log(buildLoadContext({ design, componentList, palette, pageName }));
