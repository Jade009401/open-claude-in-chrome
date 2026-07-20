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

⏳ 未开始。

## Task 0c — host 拿到"PRD→脚本"生成结果(候选 B / 侧栏 Claude)

⏳ 未开始。
