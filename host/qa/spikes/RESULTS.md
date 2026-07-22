# QA Spikes 结论

> 每条 spike 的实测结论落这里。gating:任一 spike 失败 → 停,写回 spec §11,回炉重估。

## Task 0a — 飞书授权读文档(国际版 Lark)

**环境:** 国际版 Lark(`larksuite.com`);自建应用「自动化测试」;专用知识库(Wiki)。

### Step 1–4:读"已有"文档 —— ✅ 通过(2026-07-20)

- app 身份(`app_id/app_secret`,`Domain.Lark`)成功读到知识库里的一篇 PRD。
- 目标:`.../wiki/Dw6PwpMqAigDMbk9d63jzV4rpxd` → 解析 `obj_type=docx`,标题「产品实施说明」→ 读回 **1574 字**,无权限错。
- 结论:**读取主链成立**(应用身份 + 官方 SDK v1.70.0 能读该知识库文档)。

### 关键实现发现(修正旧计划 Task 0a Step3 的假设)

1. **域名:** 国际版必须用 `Domain.Lark`(`open.larksuite.com`),非 `Domain.Feishu`。用错域名认证失败。
2. **wiki 节点 ≠ docx document_id:** URL 里的 `Dw6...` 是 **wiki `node_token`**,不能直接喂 `docx.rawContent`。
   须先 `client.wiki.v2.space.getNode({params:{token}})` 拿到 `node.obj_token`(=docx document_id)+ 校验 `obj_type==='docx'`,再 `client.docx.v1.document.rawContent({path:{document_id}})`。
   → 这解释了为何 0a 需要 `wiki:wiki:readonly` 权限(旧计划只提 `docx:document:readonly` 不够)。
3. **SDK 方法(v1.70.0,已用实例校验存在):** `client.wiki.v2.space.getNode`、`client.docx.v1.document.rawContent`。
4. **权限错码:** 91403 / 131006 会被 spike 显式标出并提示"一次授权可能不覆盖"。

### Step 5(关键·spec §11 头号未决)—— ✅ 通过(2026-07-20)

**已验证"一次性授权覆盖新建文档"成立。** 管理员在同一知识库**新建**「工作日报」文档、**未做任何额外授权**,直接读到 233 字,无权限错:
```
node host/qa/spikes/spike-lark-read.mjs "https://.../wiki/GX4PwRfomivjhjkawYnj2d6DpNd"
→ obj_type=docx title=工作日报 ✅ 233 字
```
- 结论:**授权一次知识库 → 其后新建的 docx 文档无需再授权即可用应用身份读**。spec §11 头号问题解除:走"知识库一次性授权",不必"每篇授权"或用户 OAuth。

**当前状态:0a ✅ 通过(Step 1–6 全绿)。下游读文档 gating 解除。0b/0c 仍待跑。**

## Task 0b — 编排器驱动 map/locate/act

**环境:** 我自持 primary(`node host/mcp-server.js`,stdin 走 FIFO 保活)+ 已运行的 native-host + extension;spike 作为独立 TCP client 连 18765。目标页=已打开的 Lark 文档「产品实施说明」。

### ✅ 通过(2026-07-20)—— 独立 client 驱动成立

- **接线形态(答 D11):** 编排器作为**独立 TCP client** 连 `127.0.0.1:18765` → `client_hello` → `client_ack(compatible=true)` → 发 `tool_request` 驱动四工具,响应按 `c<id>_` 前缀路由回。**无需同进程、无需新起 MCP 逻辑**,复用现有 primary + native-host + extension。代码依据 `mcp-server.js` `attachClient`(:286)/`handleNativeMessage`(:223)。
- **活体证据:** `browser_map ok=true`(Lark 页 tabId=830205078,318 blocks);`browser_locate` 多查询均返回 5 个真实锚点(带 `locator`/`title`/`role=heading`/`score`),如 `服务范围→document:section[title="二、服务范围"]`。
- **MCP 结果形态:** 工具结果是 `{content:[{type:'text', text:'<json>'}]}`,payload 在 `text` 里,须 `JSON.parse` 解开(spike 已处理;编排器接线需注意)。

### 关键发现 / 待办

1. **⚠️ primary 是 ephemeral 的:** 侧栏的 mcp-server 只在 Claude CLI 那一轮活跃时短暂存在,turn 结束即退(实测 18765 时有时无)。→ **编排器不能假设"侧栏 primary 常驻"**;要么编排器自持/拉起 primary(本 spike 用法),要么在 0c-B 触发时确保会话活跃。Task 4/7 接线以此为准。
2. **locate import 形态(答 0b Step2):** `import { locateInMap }`(纯函数)与 `new MapEngine().locate`(实例方法)都可用;**推荐直接 import `locateInMap`**(不构造 MapStore/BuildLock)。
3. **截图:** 四工具无截图原语;编排器自走 CDP 会与 extension 的 `chrome.debugger` 抢(一 tab 一 debugger)。→ **Phase 0 证据去截图化**(DOM 读回)。[代码确认,未活体测]
4. **map 生命周期:** `browser_locate/read/act` 从不建图;导航后必须重新 `browser_map`。[schema+代码确认]

### 未活体验证(诚实标注)

- **多 client 与"活跃侧栏会话"并存:** 本 spike 自持 primary 时侧栏无活跃会话,故"编排器 + 真实侧栏 client 同时"未同时在线实测(代码 `clientSockets` 支持多 client)。
- **CDP 横幅:** 目标是 Lark 文档,走 Lark 服务worker 读取路径(`lark_service_worker_cache_hit`),未必触发 chrome.debugger 横幅;**真实被测 web-app 页(非 Lark)的 CDP 横幅/act 行为需另测**。
- **待人工确认:** 运行期间 Chrome 是否弹自动化横幅、侧栏是否被挤断。

**当前状态:0b 核心(独立 client 驱动 map/locate)✅ 通过;上表 3 项列为 Task 4/7 接线注意 + 后续真实被测页复测。**

## Task 0c — host 拿到"PRD→脚本"生成结果(候选 B′ / spawn headless claude)

**读代码发现:** chat-native-host 拉起侧栏 Claude 的方式就是跑 `claude -p --output-format stream-json …`(用 CLI 登录态,无 API key)。据此得到比原 B1 更干净的 **B′**:编排器**自己 spawn 一次 headless `claude -p`** 来生成脚本,不用截侧栏聊天、不加 MCP 工具(不撞工具面锁)、不依赖活跃 primary。

### ✅ 通过(2026-07-20)

- 命令:`claude -p --output-format json --strict-mcp-config --mcp-config '{"mcpServers":{}}'`,cwd=中性目录,PRD 走 stdin。
- 实测:喂样例 PRD → **17s** 返回 `is_error=false` → 解析出合法脚本:`requirementIds=["R1","R2","R3"]`、5 个 steps、每个 step 的 `requirementId` 都在全集内(**覆盖率溯源成立**)。
- 结论:**B′ 成立**——编排器 spawn headless claude 能稳定拿回结构化脚本,零 API key。Task 3 生成落点按此接线(host 里 `script-gen.mjs` = 组 prompt + spawn CLI + 解析 + `validateScript`)。

### 注意 / 待办(Task 3 细化)

- 生成耗时(样例 17s)计入单场景端到端耗时,与止损"耗时"指标相关。
- cwd=tmpdir 避开了本项目 CLAUDE.md,但**用户级 `~/.claude/CLAUDE.md` + hooks 仍会加载**(本次未影响生成);生产/Task3 可加 `--settings` 进一步隔离。
- 模型给 step[0] 补了 `navigate`(expected 空)——prompt/schema 在 Task 3 细化(动作枚举、expected 必填规则)。

---

# ✅ Phase 0 gating 全部通过(0a / 0b / 0c)

三道 spike 均已实测通过,**下游 Task 1–7 的 gating 解除**,可进入建设:
- 0a:飞书应用身份读知识库文档(含新建)✅
- 0b:独立 TCP client 驱动 map/locate ✅(截图去化、map 生命周期、primary ephemeral 已记为接线注意)
- 0c:spawn headless claude 生成脚本(B′,零 key)✅
