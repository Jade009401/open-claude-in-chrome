// 按 URL node-id 在全量场景图里定位子树(核心:不处理全部 70k 节点,只切选中那屏)。
// 场景图是扁平 nodeChanges,靠 guid + parentIndex 重建父子;子节点按 parentIndex.position(分数序字符串)排序。

const gkey = (g) => (g ? `${g.sessionID}:${g.localID}` : null);
// URL node-id "sessionID-localID"(横杠)→ 场景图 guid 键 "sessionID:localID"。只替第一个横杠。
const nodeIdToKey = (nid) => String(nid || '').trim().replace('-', ':');

function buildIndex(nodeChanges) {
  const byGuid = new Map();
  const childrenOf = new Map();
  const symbols = new Map(); // 组件主 guid→name(INSTANCE 解引用用),需扫全量(组件常在别的页)
  for (const n of nodeChanges) {
    const k = gkey(n.guid);
    if (!k) continue;
    byGuid.set(k, n);
    if (n.type === 'SYMBOL' && n.name) symbols.set(k, n.name);
  }
  for (const n of nodeChanges) {
    const p = n.parentIndex && gkey(n.parentIndex.guid);
    if (!p) continue;
    if (!childrenOf.has(p)) childrenOf.set(p, []);
    childrenOf.get(p).push(n);
  }
  // 兄弟按分数序 position 字符串排序(Figma fractional index,字典序即视觉顺序)
  for (const arr of childrenOf.values()) {
    arr.sort((a, b) => String(a.parentIndex?.position ?? '').localeCompare(String(b.parentIndex?.position ?? '')));
  }
  return { byGuid, childrenOf, symbols };
}

export { buildIndex, gkey, nodeIdToKey };
