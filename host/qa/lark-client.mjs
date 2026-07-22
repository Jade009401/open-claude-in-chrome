// 飞书只读客户端(Task 1)。国际版 Lark,应用身份。
// 只读:读 docx 正文 + 探测是否含表格。写 bitable/发 im 留到 Task 6。
import * as lark from '@larksuiteoapi/node-sdk';
import { larkAppId, larkAppSecret, assertLarkCredentials } from './config.mjs';

// Lark docx 表格块的 block_type(公开文档:table=31)。数值口径可能随版本调整,
// 故 hasTableBlock 同时兜底判断 block 上是否带 .table 结构。
const TABLE_BLOCK_TYPE = 31;

// 纯函数:blocks 里是否含表格块。供上层判断"要不要结构化处理表格型需求"。
function hasTableBlock(blocks) {
  if (!Array.isArray(blocks)) return false;
  return blocks.some(
    (b) => b && (b.block_type === TABLE_BLOCK_TYPE || (b.table && typeof b.table === 'object')),
  );
}

// 从一个 block 取出文本元素数组。不同块类型放在不同键下(text / heading1… / bullet / ordered),
// 统一:优先 text.elements,否则扫块的各字段找带 .elements 的对象。
function blockElements(block) {
  if (!block || typeof block !== 'object') return [];
  if (Array.isArray(block.text?.elements)) return block.text.elements;
  for (const v of Object.values(block)) {
    if (v && typeof v === 'object' && Array.isArray(v.elements)) return v.elements;
  }
  return [];
}

// 纯函数:从 blocks 抽出超链接与 @文档引用(A 方案:只列出,不跟读)。
// rawContent 会丢链接网址,故从 blocks 结构里取。
function extractRefs(blocks) {
  const links = [];
  const mentions = [];
  if (!Array.isArray(blocks)) return { links, mentions };
  for (const b of blocks) {
    for (const e of blockElements(b)) {
      const url = e?.text_run?.text_element_style?.link?.url;
      if (url) {
        let decoded = url;
        try { decoded = decodeURIComponent(url); } catch {}
        links.push({ text: e.text_run.content || '', url: decoded });
      }
      if (e?.mention_doc) {
        mentions.push({
          title: e.mention_doc.title || '',
          token: e.mention_doc.token || '',
          objType: e.mention_doc.obj_type ?? null,
        });
      }
    }
  }
  return { links, mentions };
}

function createClient() {
  assertLarkCredentials();
  return new lark.Client({
    appId: larkAppId,
    appSecret: larkAppSecret,
    appType: lark.AppType.SelfBuild,
    domain: lark.Domain.Lark, // 国际版 larksuite.com
    loggerLevel: lark.LoggerLevel.error,
  });
}

// 从 wiki/docx 链接或裸 token 解析出 docx 的 document_id。
// wiki 链接给的是 node_token,须 getNode 解析出 obj_token(=document_id)。
async function resolveDocumentId(client, input) {
  const raw = String(input || '').trim();
  const wiki = raw.match(/\/wiki\/([A-Za-z0-9]+)/);
  const docx = raw.match(/\/docx\/([A-Za-z0-9]+)/);
  if (docx) return docx[1];
  const nodeToken = wiki ? wiki[1] : /^[A-Za-z0-9]+$/.test(raw) ? raw : null;
  if (!nodeToken) throw new Error(`无法从输入解析 token: ${raw}`);
  // 裸 token 或 wiki 链接:先当 wiki 节点解析。
  const resp = await client.wiki.v2.space.getNode({ params: { token: nodeToken } });
  if (resp.code && resp.code !== 0) {
    throw new Error(`wiki.getNode 失败 code=${resp.code} msg=${resp.msg}`);
  }
  const node = resp.data?.node;
  if (node?.obj_type !== 'docx') {
    throw new Error(`节点不是 docx(是 ${node?.obj_type}),暂不支持`);
  }
  return node.obj_token;
}

// 拉全部 blocks(分页,带上限防跑飞),用于表格探测 + 供上层结构化。
async function listBlocks(client, documentId, { maxPages = 10, pageSize = 500 } = {}) {
  const items = [];
  let pageToken;
  for (let i = 0; i < maxPages; i += 1) {
    const resp = await client.docx.v1.documentBlock.list({
      path: { document_id: documentId },
      params: { page_size: pageSize, ...(pageToken ? { page_token: pageToken } : {}) },
    });
    if (resp.code && resp.code !== 0) {
      throw new Error(`documentBlock.list 失败 code=${resp.code} msg=${resp.msg}`);
    }
    for (const it of resp.data?.items || []) items.push(it);
    if (!resp.data?.has_more) break;
    pageToken = resp.data?.page_token;
    if (!pageToken) break;
  }
  return items;
}

// 读一篇 PRD:返回正文纯文本 + 是否含表格 + blocks(供上层)。
async function readDoc(input, { client } = {}) {
  const c = client || createClient();
  const documentId = await resolveDocumentId(c, input);

  const contentResp = await c.docx.v1.document.rawContent({
    path: { document_id: documentId },
    params: { lang: 0 },
  });
  if (contentResp.code && contentResp.code !== 0) {
    throw new Error(`docx.rawContent 失败 code=${contentResp.code} msg=${contentResp.msg}`);
  }
  const content = contentResp.data?.content || '';

  const blocks = await listBlocks(c, documentId);
  return {
    documentId,
    content,
    hasTable: hasTableBlock(blocks),
    refs: extractRefs(blocks), // { links:[{text,url}], mentions:[{title,token,objType}] }(A:只列不跟读)
    blocks, // 有表格时供上层结构化;无表格上层可忽略
  };
}

// —— Task 6 输出层:写结果表(bitable)+ 播报(im)——

// 取一个 bitable 的第一张数据表 table_id。
async function firstTableId(client, appToken) {
  const tl = await client.bitable.v1.appTable.list({ path: { app_token: appToken }, params: { page_size: 20 } });
  return tl.data?.items?.[0]?.table_id || null;
}

// 往结果表写一条运行记录。fields 为 { 用例, AI判定, 耗时ms, 证据链接, 人工改判, 脚本改动 }(值均字符串)。
async function writeRunRecord(client, appToken, tableId, fields) {
  const r = await client.bitable.v1.appTableRecord.create({
    path: { app_token: appToken, table_id: tableId },
    data: { fields },
  });
  if (r.code) throw new Error(`writeRunRecord 失败 code=${r.code} msg=${r.msg}`);
  return r.data?.record?.record_id;
}

// 读回结果表全部行(供止损计算)。
async function listRunRecords(client, appToken, tableId) {
  const rr = await client.bitable.v1.appTableRecord.list({ path: { app_token: appToken, table_id: tableId }, params: { page_size: 500 } });
  return rr.data?.items || [];
}

// —— 自动创建:共享结果表 + 路由行(路由总表没匹配行时用)——
const SHARED_RESULT_TABLE_NAME = 'QA结果表';
const RESULT_FIELDS = ['系统', '用例', 'AI判定', '耗时ms', '证据链接', '人工改判', '脚本改动'];

// 找应用空间里的「QA结果表」bitable;没有就建一张(补齐所需字段)。返回 { appToken, tableId, url, created }。
async function ensureSharedResultTable(client) {
  const list = await client.drive.v1.file.list({ params: { page_size: 100 } });
  const found = (list.data?.files || []).find((f) => f.name === SHARED_RESULT_TABLE_NAME && f.type === 'bitable');
  if (found) {
    return { appToken: found.token, tableId: await firstTableId(client, found.token), url: found.url, created: false };
  }
  const created = await client.bitable.v1.app.create({ data: { name: SHARED_RESULT_TABLE_NAME } });
  if (created.code) throw new Error(`创建结果表失败 code=${created.code} msg=${created.msg}`);
  const appToken = created.data?.app?.app_token;
  const url = created.data?.app?.url || `base/${appToken}`;
  const tableId = await firstTableId(client, appToken);
  // 补齐所需字段(默认主字段保留;逐个建,已存在报错则忽略)。type:1 = 文本。
  for (const name of RESULT_FIELDS) {
    try {
      await client.bitable.v1.appTableField.create({ path: { app_token: appToken, table_id: tableId }, data: { field_name: name, type: 1 } });
    } catch { /* 字段已存在等 → 忽略 */ }
  }
  return { appToken, tableId, url, created: true };
}

// 往路由总表加一行。fields = { 端, 系统模块, 结果表链接, 播报群名 }。
async function addRoutingRow(client, appToken, tableId, fields) {
  const r = await client.bitable.v1.appTableRecord.create({ path: { app_token: appToken, table_id: tableId }, data: { fields } });
  if (r.code) throw new Error(`加路由行失败 code=${r.code} msg=${r.msg}`);
  return r.data?.record?.record_id;
}

// 播报到群(纯文本)。Phase 0:每次运行一张汇总卡 + 涉及文档 URL(透明审计流)。
async function broadcast(client, chatId, text) {
  const r = await client.im.v1.message.create({
    params: { receive_id_type: 'chat_id' },
    data: { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text }) },
  });
  if (r.code) throw new Error(`broadcast 失败 code=${r.code} msg=${r.msg}`);
  return r.data?.message_id;
}

export {
  hasTableBlock,
  extractRefs,
  createClient,
  resolveDocumentId,
  readDoc,
  TABLE_BLOCK_TYPE,
  firstTableId,
  writeRunRecord,
  listRunRecords,
  broadcast,
  ensureSharedResultTable,
  addRoutingRow,
  SHARED_RESULT_TABLE_NAME,
};
