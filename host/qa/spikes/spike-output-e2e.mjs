// 端到端验证飞书输出链(真连飞书):路由 → 写结果表 → 播报(含文档URL,透明)。
// 用法:node host/qa/spikes/spike-output-e2e.mjs "用户端-理财"
import { createClient, writeRunRecord, broadcast } from '../lark-client.mjs';
import { resolveTargets } from '../routing.mjs';
import { summarize } from '../report.mjs';

const routeKey = process.argv[2] || '用户端-理财';

async function main() {
  const c = createClient();

  // 1. 按 routeKey 解析落点(结果表 + 群),全靠应用自管空间 + 群名解析。
  const t = await resolveTargets(c, routeKey);
  if (!t.ok) { console.log('[e2e] 路由解析失败:', t.reason); process.exitCode = 1; return; }
  console.log('[e2e] 路由解析:', JSON.stringify({ routeKey, resultTableUrl: t.resultTableUrl, groupName: t.groupName, chatId: t.chatId }));
  if (!t.chatId) { console.log('[e2e] ⚠️ 群名解析不到 chat_id,停'); process.exitCode = 1; return; }

  // 2. 往结果表写一条假运行记录(人工改判/脚本改动 留空待人工)。
  const recId = await writeRunRecord(c, t.resultToken, t.resultTableId, {
    用例: '冒烟-登录页标题',
    AI判定: '通过',
    耗时ms: '1234',
    证据链接: '(DOM读回快照:标题=登录)',
    人工改判: '',
    脚本改动: '',
  });
  console.log('[e2e] 写结果表 record_id=', recId);

  // 3. 汇总 + 播报(含文档 URL = 透明审计流)。
  const s = summarize([{ verdict: 'pass', requirementId: 'R1' }], ['R1']);
  const text = [
    `【QA 结果播报】${routeKey}`,
    `通过 ${s.pass} / 失败 ${s.fail} / 不确定 ${s.uncertain}｜覆盖率 ${s.coverage}`,
    `结果表: ${t.resultTableUrl}`,
    `路由总表: ${t.routingUrl}`,
  ].join('\n');
  const msgId = await broadcast(c, t.chatId, text);
  console.log('[e2e] 播报 message_id=', msgId);
  console.log('[e2e] ✅ 端到端打通:路由→写结果表→播报(含文档URL)。去群里看播报、去结果表看新行。');
}

main().catch((e) => {
  console.log('[e2e] 异常:', e?.message || e);
  const d = e?.response?.data; if (d) console.log('响应:', d.code, d.msg);
  process.exitCode = 1;
});
