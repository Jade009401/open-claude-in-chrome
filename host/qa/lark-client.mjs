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

export { hasTableBlock, extractRefs, createClient, resolveDocumentId, readDoc, TABLE_BLOCK_TYPE };
