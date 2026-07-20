// 结果路由(设计 §11.5:AI 自管知识空间 + 播报文档地址实现透明)。
// 路由总表/结果表由应用自建自拥;应用在自己空间按名字找路由总表,零本地配置、不碰共享知识库。
import { createClient } from './lark-client.mjs';

const ROUTING_BASE_NAME = 'QA路由总表';

// bitable 文本字段读回可能是字符串或 [{type,text}] 数组,统一取纯文本。
function cellText(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map((x) => (x && x.text != null ? x.text : x)).join('');
  if (typeof v === 'object' && v.text != null) return String(v.text);
  return String(v);
}

// 从 base url 抽 app_token(纯函数)。
function baseTokenFromUrl(url) {
  const m = String(url || '').match(/\/base\/([A-Za-z0-9]+)/);
  return m ? m[1] : null;
}

// routeKey(如 "用户端-理财")→ 匹配路由行(纯函数)。
function resolveRoute(routes, routeKey) {
  const idx = String(routeKey || '').indexOf('-');
  const 端 = idx >= 0 ? routeKey.slice(0, idx) : routeKey;
  const mod = idx >= 0 ? routeKey.slice(idx + 1) : '';
  const row = (routes || []).find((r) => r.端 === 端 && r.系统模块 === mod);
  if (!row) return { ok: false, reason: `路由总表无此键: ${routeKey}` };
  return { ok: true, resultTableUrl: row.结果表链接, groupName: row.播报群名, row };
}

// —— 以下为 IO(靠真实飞书验证)——

// 在应用自己空间按名字找路由总表 → { appToken, url }。
async function findRoutingBase(client) {
  const r = await client.drive.v1.file.list({ params: { page_size: 100 } });
  const file = (r.data?.files || []).find((f) => f.name === ROUTING_BASE_NAME && f.type === 'bitable');
  if (!file) throw new Error(`应用空间里找不到「${ROUTING_BASE_NAME}」多维表格`);
  return { appToken: file.token, url: file.url };
}

// 读路由总表所有行。
async function readRoutes(client, appToken) {
  const tl = await client.bitable.v1.appTable.list({ path: { app_token: appToken }, params: { page_size: 20 } });
  const tableId = tl.data?.items?.[0]?.table_id;
  const rr = await client.bitable.v1.appTableRecord.list({ path: { app_token: appToken, table_id: tableId }, params: { page_size: 200 } });
  return (rr.data?.items || []).map((rec) => ({
    端: cellText(rec.fields['端']),
    系统模块: cellText(rec.fields['系统模块']),
    结果表链接: cellText(rec.fields['结果表链接']),
    播报群名: cellText(rec.fields['播报群名']),
  }));
}

// 群名 → chat_id。
async function resolveGroupChatId(client, groupName) {
  const r = await client.im.v1.chat.list({ params: { page_size: 100 } });
  const chat = (r.data?.items || []).find((ch) => ch.name === groupName);
  return chat?.chat_id || null;
}

// 便捷:按 routeKey 解析出完整落点(结果表 token/tableId + 群 chat_id + 各文档 URL)。
async function resolveTargets(client, routeKey) {
  const base = await findRoutingBase(client);
  const routes = await readRoutes(client, base.appToken);
  const route = resolveRoute(routes, routeKey);
  if (!route.ok) return { ok: false, reason: route.reason, routingUrl: base.url };
  const resultToken = baseTokenFromUrl(route.resultTableUrl);
  const tl = await client.bitable.v1.appTable.list({ path: { app_token: resultToken }, params: { page_size: 20 } });
  const resultTableId = tl.data?.items?.[0]?.table_id;
  const chatId = await resolveGroupChatId(client, route.groupName);
  return {
    ok: true,
    routingUrl: base.url,
    resultTableUrl: route.resultTableUrl,
    resultToken,
    resultTableId,
    groupName: route.groupName,
    chatId,
  };
}

export {
  ROUTING_BASE_NAME,
  cellText,
  baseTokenFromUrl,
  resolveRoute,
  findRoutingBase,
  readRoutes,
  resolveGroupChatId,
  resolveTargets,
};
