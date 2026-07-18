# generic_dom 通用降噪设计

- 日期:2026-07-18
- 分支:`spec/lark-prd-qa`
- 状态:设计待评审
- 方案:C(拆分 —— 采集器折叠 + kernel 预算/coverage)

## 1. 背景与问题

侧栏 `browser_map` 在重页(交易类、长 feed、订单簿)上建图失败:采集器把节点收到 6000 上限、报
`generic_dom_node_limit_reached`,导致地图不完整、Claude 无法总结页面。实测交易页 6269 > 6000。

根因(已读代码定位,非推断):

- 整条 `browser_map` 建图管线 **在扩展侧**(host 的 `host/map/map-engine.mjs` 是另一条不相干管线,不参与)。
- 截断发生在 **采集器**:`extension/universal-browser-map.js` 的 `genericDomAdapter`(约 :140–179)按 `composedElements(document)`
  的 **广度优先(BFS,队列遍历 composed 树,:87–105)顺序** 收集,`add()` 到 `nodes.length >= maxNodes`(默认 6000)就停收。
  重复结构(订单簿/feed)在遍历前段吃光预算,靠后的锚点(标题/控件)连被 kernel 看到的机会都没有。
- kernel(`extension/universal-map-kernel.js` 的 `compileEvidenceBatches`,跑在 `background.js` service worker)**不折叠同层重复兄弟**:
  `evidenceKey` 对 generic dom 节点返回 `dom:frameId:domPath`,每条重复行 `domPath`(`nth-of-type`)不同 → 各自唯一 → 全保留;
  `mergeGroup` 只做 **跨采集器同一节点** 合并,不是同层重复兄弟折叠。

## 2. 目标与非目标

### 目标
- **通用**:只靠结构性信号(兄弟同构签名、语义锚点类型),**零** 页面/交易所/URL/选择器硬编码。
- **成功标准**:交易类重页地图 **建全 + 可总结**;`browser_map` 不再因重复结构报 `generic_dom_node_limit_reached`。
- 两条策略(用户指定,均为必做):① 重复同构结构折叠(样本 + 计数);② 锚点优先预算。

### 非目标
- 不追求把每一条被折叠的行都可逐条读取(见 §6 下钻策略:仅样本可操作)。
- 不改 host 侧任何管线;不动 `~/Downloads` vendor(本仓库即事实源,单一源,无同步步骤)。
- 不解决"折叠后仍 > 上限的超大且全唯一页"(见 §9 已知限制)。

## 3. 落点与数据流

```
每帧注入 core/kernel/collector
  → genericDomAdapter 收集           ← 【改动①:同构折叠】
  → scan() 产出 evidenceBatches
  → background.js remapNodes(前缀/重映射 parentId)
  → applyCollectorPolicy(分配 role)
  → kernel.compileEvidenceBatches      ← 【改动②:锚点预算 + coverage 重算 + 认 collapsed_group】
  → 地图返回
```

硬约束(决定落点):6000 截断在采集器、**早于** kernel,kernel 事后够不着被截断的节点。故:
- **折叠** 需活 DOM、且必须在截断前发生 → 落 **采集器**。
- **锚点优先预算 / coverage** 是纯数据语义、可单测、惠及所有采集器 → 落 **kernel**。

## 4. 改动① 采集器折叠 `extension/universal-browser-map.js`

### 4.1 结构签名(通用,抗动态 class)
```
structuralSignature(el) =
  tag                                   // el.tagName
  | role                                // 复用现有 roleOf(el)
  | classShape                          // el.classList 每个 token 去掉尾部数字后排序、取前 N 个
  | childTagShape                       // [...el.children].map(c=>c.tagName).slice(0,12).join(',')
```
理由:订单簿 500 行的 `tag/role/子标签序列` 全同,签名一致;标题、按钮、不同区块签名各异。去数字的
classShape 抵御 `row-3 / active-12` 这类每行不同的动态 class。

### 4.2 纯函数承载折叠决策(便于单测)
把折叠决策抽成不碰 DOM 的纯函数:
```
planCollapse(candidates, { minGroup, samples }) -> { emit: [...], groups: [...] }
```
- 输入 `candidates`:`{ index, parentKey, signature, ... }`(由采集器从 DOM 预抽)。
- 输出:哪些候选保留为样本、哪些并入哪个折叠组、每组的 `totalCount/hiddenCount`。
- 采集器只保留"从 DOM 抽 candidates + 按 plan 产出节点"这层薄壳(需 DOM),决策逻辑全在纯函数里。

### 4.3 两遍收集(替换现在的单遍硬截断)
1. **gather**:遍历 `composedElements`,套 **现有** 语义/文本过滤(`semanticTags`、有文本、跳过表格交给 table adapter),
   把轻量候选描述压入数组;设硬顶 `GATHER_CEILING`(默认 25000)防病态页 OOM。
2. **plan**:`planCollapse` 统计每个 `parentKey|signature` 组大小。
3. **emit**:组 `total >= COLLAPSE_MIN_GROUP` 时,留前 `COLLAPSE_SAMPLES` 个真实节点,其余并入一个 `collapsed_group`
   节点;组小于阈值全留。`maxNodes`(6000)仍作最后安全网。

`parentKey`:用父元素在本次采集内分配的 id(或 WeakMap 引用序号)标识,保证"同一父下"的判定。

### 4.4 `collapsed_group` 节点结构
```
{
  id, parentId: <原共享父 id>,
  type: 'collapsed_group',
  role,                                  // 取样本 role
  title: `${totalCount}× ${tag}.${classHint}`,
  text:  <首个样本 text,截断>,
  collapsed: { signature, sampleIds: [...K], totalCount, hiddenCount },
  bounds: <首样本 bounds 或并集>,
  confidence: 0.7,
  adapter: 'generic_dom'
}
```
K 个样本节点 **reparent**:其 `parentId` 指向该 `collapsed_group`;`collapsed_group.parentId` 指向原共享父。
树形变为 `父 → collapsed_group → [K 样本]`,使 `read(折叠组)` 天然返回样本。

### 4.5 collection 状态软化
- 折叠把节点数压回上限内 → `collection.status='snapshot_complete'`、`truncated=false`,附
  `collapsedGroups: <组数>`、`hiddenNodes: <被折叠总数>`。
- **必须** 同时把 warning 串(如 `N 处重复区域已折叠`)推入 `collection.warnings` —— kernel 的
  `coverageFromBatches` 只从 `batch.collection.warnings` 派生 `complete_with_warnings`(kernel :299/:308),
  不推就透不出(§5.3 依赖此)。
- 仅当折叠后 **仍** 触 `maxNodes` → 保留 `truncated:true` + `generic_dom_node_limit_reached`(诚实,见 §9)。

## 5. 改动② kernel `extension/universal-map-kernel.js`

### 5.1 认 `collapsed_group`
- 加入 `CONTENT_TYPES`(使 `inferScopeHint` 视其为内容、不被当装饰丢弃)。
- 专属 `evidenceKey`:`collapse:${frameId}:${parentKey}:${signature}`,避免被跨采集器误合并。
- `shouldIncludeSupportingNode`:加入 `CONTENT_TYPES` 后 `inferScopeHint` 已返回 `content`、自动放行,
  此步冗余但无害,实现时确认即可。
- **避免被误升级**:`promoteNumberedAnchor`/`numberedRunSet` 会把"编号项"升级成 `document_section`。
  `collapsed_group` 的 title 用 `${totalCount}× …` 中的 `×` 使 `core.extractLeadingNumber`(core :26)不识别为编号(安全);
  为防 title 格式后续变动踩坑,**在 `promoteNumberedAnchor` 显式排除 `collapsed_group` 类型**(双保险)。

### 5.2 锚点优先全局预算(策略②)
`compileEvidenceBatches` 合并出 `mergedNodes` 后,若 `mergedNodes.length > OUTPUT_NODE_BUDGET`:
- 按优先级保留、从低到高砍:
  `纯 dom_node(scope=chrome/nav)` < `纯 dom_node(content)` < `有 aria/title 的 dom_node` <
  `编号项/collapsed_group` < `控件/表单` < `标题/document_section`。
- **保留被留节点的父链**(不产生孤儿:被留节点的祖先一并保留)。
- 默认仅在超 `OUTPUT_NODE_BUDGET` 时触发;不超则不动。

### 5.3 coverage 重算
`coverageFromBatches` / `normalizeCollection` 调整:
- 折叠/预算后锚点齐全 → 报 `complete_with_warnings`,warning:`N 处重复区域已折叠`;**不再** 因
  `generic_dom_node_limit_reached` 逼成 `incomplete`。
- 仅当采集器真触顶丢了锚点(§4.5 的 `truncated:true`)才 `incomplete`。

## 6. 下钻 / 读取(按已定"样本可操作 + 其余仅计数")

- `act`:走样本节点的 `domPath`,点击/输入照常。
- `read(collapsed_group)`:返回组元数据(`totalCount/hiddenCount/signature`)+ K 个样本(样本是其子节点,
  `core.read` 靠父子关系天然返回)。**隐藏行不重展开**。
- 无需改 `extension/universal-browser-map-core.js`(`read`/`locate`/`normalizeNode` 对新 type 是通用处理)。
  实现时若发现 `detectPageType`/`defaultLocator` 对 `collapsed_group` 有异常再回补,列为待验证点。

## 7. 常量与旋钮(默认值)

| 常量 | 默认 | 作用 |
|------|------|------|
| `COLLAPSE_MIN_GROUP` | 8 | 同签名兄弟 ≥ 此数才折叠 |
| `COLLAPSE_SAMPLES` | 3 | 每组保留的真实样本数 |
| `GATHER_CEILING` | 25000 | 采集器候选硬顶,防病态页 |
| `maxNodes`(采集器) | 6000 | 保持不变,作最后安全网 |
| `OUTPUT_NODE_BUDGET`(kernel) | 5000 | 合并后地图节点预算,仅超限触发锚点砍取 |

## 8. 测试

仓库当前 **无测试框架/无 test 文件**。引入 `node:test` + `node:assert`(**零新依赖**),在 `host/package.json`
加 `"test": "node --test"`(或扩展侧独立跑)。

- `planCollapse`:合成候选数组 → 断言"≥阈值折叠、<阈值全留、样本数、totalCount/hiddenCount"。
- kernel 预算:合成节点数组 → 断言"超预算时锚点全留、纯文本先砍、父链不断"。
- kernel coverage:合成 batch → 断言"折叠场景报 complete_with_warnings、真丢锚点报 incomplete"。
- 端到端:交易页人工验证 `browser_map` 不再报 `node_limit`、地图含标题/控件、可总结。

## 9. 已知限制与风险

- **签名过宽误折叠**:用 `childTagShape` + 去数字 `classShape` + 阈值 ≥8 兜底;仍误折叠时调大阈值或加签名维度。
- **超大且全唯一页**:折叠后仍 > 6000 → 采集器盲截(BFS 序),kernel 无法找回 → 诚实报 `incomplete`,不假装完整。
  作为已知限制,后续可加"采集器截断也锚点优先"硬化(本次不做,YAGNI)。
- **reparent 影响 parentId 链**:`background.js` 的 `remapNodes` 按 batch 内 `idMap` 重映射 `parentId`,折叠组与样本 id
  均在同 batch → 可正确重映射;实现时需单测覆盖 remap 后父子关系。

## 10. 影响面

- 改动文件:`extension/universal-browser-map.js`、`extension/universal-map-kernel.js`;`core.js` 预计不动(待验证)。
- host 不变;扩展 `.js` 直接被 `importScripts`/`executeScript` 加载,**无构建步骤**,reload 即生效。
- 属行为变化 → **实现阶段** 走 `pipeline:dev` + 新鲜上下文复审;完成须有验证证据(端到端 + 单测)。

## 11. 不做(Out of scope)
- host `map-engine.mjs` 管线、`web-app-core` 孪生同步、`install.sh` 对齐(独立待办)。
- 每条隐藏行可逐条读取 / 折叠组可完全再展开。
- 针对具体站点的任何特判。
