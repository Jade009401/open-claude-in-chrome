import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLarkBrowserSessionBackend } from "./lark-session-backend.js";

const TEXT_CONTAINER_KEYS = [
  "page",
  "text",
  "heading1",
  "heading2",
  "heading3",
  "heading4",
  "heading5",
  "heading6",
  "heading7",
  "heading8",
  "heading9",
  "bullet",
  "ordered",
  "code",
  "quote",
  "equation",
  "todo",
];

const BLOCK_TYPE_NAMES = new Map([
  [1, "page"],
  [2, "text"],
  [3, "heading1"],
  [4, "heading2"],
  [5, "heading3"],
  [6, "heading4"],
  [7, "heading5"],
  [8, "heading6"],
  [9, "heading7"],
  [10, "heading8"],
  [11, "heading9"],
  [12, "bullet"],
  [13, "ordered"],
  [14, "code"],
  [15, "quote"],
  [16, "equation"],
  [17, "todo"],
  [19, "callout"],
  [22, "divider"],
  [23, "file"],
  [27, "image"],
  [31, "table"],
  [32, "table_cell"],
]);

const DEFAULT_CONFIG_PATH = process.platform === "darwin"
  ? path.join(os.homedir(), "Library", "Application Support", "ClaudeSidebarHost", "lark-adapter.json")
  : path.join(os.homedir(), ".config", "claude-sidebar", "lark-adapter.json");

let sdkPromise = null;
let cachedConfig = null;
let cachedConfigPath = null;
let cachedConfigMtime = -1;
let cachedClient = null;
let cachedClientKey = "";
let larkWriteTail = Promise.resolve();
let lastLarkWriteAt = 0;

async function runLarkWrite(fn, minIntervalMs = 340) {
  let release;
  const previous = larkWriteTail;
  larkWriteTail = new Promise((resolve) => { release = resolve; });
  await previous;
  try {
    const waitMs = Math.max(0, minIntervalMs - (Date.now() - lastLarkWriteAt));
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    return await fn();
  } finally {
    lastLarkWriteAt = Date.now();
    release();
  }
}

function result(payload, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
    ...(isError ? { isError: true } : {}),
  };
}

function fail(message, details = {}) {
  return result({ ok: false, error: message, ...details }, true);
}

function cloneJson(value) {
  if (value === undefined || value === null) return value;
  return JSON.parse(JSON.stringify(value));
}

function configPath() {
  return process.env.CLAUDE_SIDEBAR_LARK_CONFIG || DEFAULT_CONFIG_PATH;
}

function readConfig() {
  const file = configPath();
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return {
      configured: false,
      configPath: file,
      error: "Lark Adapter 未配置。运行 ClaudeSidebarHost/configure-lark-adapter.sh 后再试。",
    };
  }

  if (cachedConfigPath === file && cachedConfigMtime === stat.mtimeMs && cachedConfig) {
    return cachedConfig;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    const appId = String(parsed.appId || "").trim();
    const appSecret = String(parsed.appSecret || "").trim();
    const domain = parsed.domain === "feishu" ? "feishu" : "lark";
    if (!appId || !appSecret) {
      throw new Error("appId/appSecret 不能为空");
    }
    cachedConfig = {
      configured: true,
      configPath: file,
      appId,
      appSecret,
      domain,
    };
    cachedConfigPath = file;
    cachedConfigMtime = stat.mtimeMs;
    return cachedConfig;
  } catch (error) {
    return {
      configured: false,
      configPath: file,
      error: `Lark Adapter 配置无效：${error?.message || String(error)}`,
    };
  }
}

async function loadSdk() {
  if (!sdkPromise) sdkPromise = import("@larksuiteoapi/node-sdk");
  return sdkPromise;
}

async function getClient(context) {
  const config = readConfig();
  if (!config.configured) throw new Error(config.error);
  const sdk = await loadSdk();

  const host = safeUrl(context?.url)?.hostname || "";
  const inferredDomain = host.endsWith(".feishu.cn") || host === "feishu.cn"
    ? "feishu"
    : host.endsWith(".larksuite.com") || host === "larksuite.com"
      ? "lark"
      : config.domain;

  const key = `${config.appId}:${config.appSecret}:${inferredDomain}`;
  if (cachedClient && cachedClientKey === key) return cachedClient;

  cachedClient = new sdk.Client({
    appId: config.appId,
    appSecret: config.appSecret,
    appType: sdk.AppType.SelfBuild,
    domain: inferredDomain === "feishu" ? sdk.Domain.Feishu : sdk.Domain.Lark,
    loggerLevel: sdk.LoggerLevel.error,
  });
  cachedClientKey = key;
  return cachedClient;
}

function safeUrl(value) {
  try {
    return new URL(String(value || ""));
  } catch {
    return null;
  }
}

export function parseLarkPage(url) {
  const parsed = safeUrl(url);
  if (!parsed) return null;
  const host = parsed.hostname.toLowerCase();
  const isLark = host === "larksuite.com" || host.endsWith(".larksuite.com");
  const isFeishu = host === "feishu.cn" || host.endsWith(".feishu.cn");
  if (!isLark && !isFeishu) return null;

  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const kind = parts[0];
  const token = parts[1];
  if (!token) return null;

  if (kind === "docx") return { kind: "docx", token, url: parsed.href, host };
  if (kind === "wiki") return { kind: "wiki", token, url: parsed.href, host };
  if (kind === "docs") return { kind: "legacy-doc", token, url: parsed.href, host };
  return null;
}

export function isLarkDocumentContext(context) {
  return Boolean(parseLarkPage(context?.url));
}

function assertApiResponse(response, action) {
  const code = Number(response?.code || 0);
  if (code !== 0) {
    const message = response?.msg || "Unknown Lark API error";
    throw new Error(`${action} failed (${code}): ${message}`);
  }
  return response?.data || {};
}

async function resolveDocument(client, context, explicitDocumentId) {
  if (explicitDocumentId) {
    return { documentId: explicitDocumentId, source: "explicit", page: parseLarkPage(context?.url) };
  }

  const page = parseLarkPage(context?.url);
  if (!page) throw new Error("当前页面不是支持的 Lark/Feishu 文档页面。");
  if (page.kind === "legacy-doc") {
    throw new Error("v6.2 暂不支持旧版 /docs 文档。请先转换为新版 Docx，或使用浏览器操作模式。");
  }
  if (page.kind === "docx") {
    return { documentId: page.token, source: "docx-url", page };
  }

  const data = assertApiResponse(
    await client.wiki.space.getNode({ params: { token: page.token, obj_type: "wiki" } }),
    "Resolve Wiki node",
  );
  const node = data.node;
  if (!node?.obj_token) throw new Error("Wiki 节点没有可解析的 obj_token。");
  if (node.obj_type !== "docx") {
    throw new Error(`当前 Wiki 节点类型是 ${node.obj_type}，v6.2 只支持 Docx 文档。`);
  }
  return { documentId: node.obj_token, source: "wiki-node", page, wikiNode: node };
}

function blockTypeName(block) {
  return BLOCK_TYPE_NAMES.get(Number(block?.block_type)) || `block_${block?.block_type ?? "unknown"}`;
}

function textContainer(block) {
  for (const key of TEXT_CONTAINER_KEYS) {
    const value = block?.[key];
    if (value && Array.isArray(value.elements)) return { key, value };
  }
  return null;
}

function elementText(element) {
  if (element?.text_run && typeof element.text_run.content === "string") return element.text_run.content;
  if (element?.mention_user) return `@${element.mention_user.user_id || "user"}`;
  if (element?.mention_doc) return element.mention_doc.title || element.mention_doc.url || "[document]";
  if (element?.equation) return element.equation.content || "[equation]";
  if (element?.link_preview) return element.link_preview.title || element.link_preview.url || "[link]";
  if (element?.inline_block) return "[inline-block]";
  if (element?.file) return "[file]";
  if (element?.reminder) return "[reminder]";
  return "";
}

function blockText(block) {
  const container = textContainer(block);
  if (!container) return "";
  return container.value.elements.map(elementText).join("");
}

function textOnlyElements(block) {
  const container = textContainer(block);
  if (!container) throw new Error(`Block ${block?.block_id || "unknown"} is not a rich-text block.`);
  const elements = container.value.elements || [];
  if (elements.some((element) => !element?.text_run || typeof element.text_run.content !== "string")) {
    throw new Error(
      `Block ${block?.block_id || "unknown"} contains mention/inline/file/equation content. ` +
      "v6.2 intentionally refuses destructive text patching on mixed rich text; use browser fallback for this block.",
    );
  }
  return elements.map((element) => ({
    text_run: {
      content: element.text_run.content,
      ...(element.text_run.text_element_style
        ? { text_element_style: cloneJson(element.text_run.text_element_style) }
        : {}),
    },
  }));
}

function stylesEqual(a, b) {
  return JSON.stringify(a || null) === JSON.stringify(b || null);
}

function normalizeElements(elements) {
  const normalized = [];
  for (const element of elements) {
    const content = element?.text_run?.content ?? "";
    if (!content) continue;
    const style = element.text_run.text_element_style;
    const previous = normalized.at(-1);
    if (previous && stylesEqual(previous.text_run.text_element_style, style)) {
      previous.text_run.content += content;
      continue;
    }
    normalized.push({
      text_run: {
        content,
        ...(style ? { text_element_style: cloneJson(style) } : {}),
      },
    });
  }
  if (normalized.length === 0) normalized.push({ text_run: { content: "" } });
  return normalized;
}

function flatText(elements) {
  return elements.map((element) => element.text_run.content).join("");
}

function spliceElements(elements, start, end, replacement) {
  const current = flatText(elements);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > current.length) {
    throw new Error(`Invalid text range ${start}..${end} for block length ${current.length}.`);
  }

  let cursor = 0;
  let insertionStyle = null;
  const before = [];
  const after = [];

  for (const element of elements) {
    const content = element.text_run.content;
    const segStart = cursor;
    const segEnd = cursor + content.length;
    const style = element.text_run.text_element_style;

    if (start >= segStart && start <= segEnd && insertionStyle === null) {
      insertionStyle = style ? cloneJson(style) : undefined;
    }

    if (segStart < start) {
      const keepEnd = Math.min(content.length, start - segStart);
      if (keepEnd > 0) {
        before.push({
          text_run: {
            content: content.slice(0, keepEnd),
            ...(style ? { text_element_style: cloneJson(style) } : {}),
          },
        });
      }
    }

    if (segEnd > end) {
      const keepStart = Math.max(0, end - segStart);
      if (keepStart < content.length) {
        after.push({
          text_run: {
            content: content.slice(keepStart),
            ...(style ? { text_element_style: cloneJson(style) } : {}),
          },
        });
      }
    }

    cursor = segEnd;
  }

  const inserted = replacement
    ? [{ text_run: { content: replacement, ...(insertionStyle ? { text_element_style: insertionStyle } : {}) } }]
    : [];
  return normalizeElements([...before, ...inserted, ...after]);
}

function blockSummary(block, maxText = 240) {
  const text = blockText(block);
  return {
    blockId: block?.block_id || null,
    parentId: block?.parent_id || null,
    type: blockTypeName(block),
    text: text.length > maxText ? `${text.slice(0, maxText)}…` : text,
    textLength: text.length,
    editableTextOnly: Boolean(textContainer(block)) && (textContainer(block)?.value?.elements || []).every(
      (element) => Boolean(element?.text_run && typeof element.text_run.content === "string"),
    ),
  };
}

async function getDocumentMeta(client, documentId) {
  const data = assertApiResponse(
    await client.docx.document.get({ path: { document_id: documentId } }),
    "Get document",
  );
  return data.document || {};
}

async function listBlocks(client, documentId, maxBlocks = 1000) {
  const blocks = [];
  let pageToken;
  let hasMore = true;

  while (hasMore && blocks.length < maxBlocks) {
    const data = assertApiResponse(
      await client.docx.documentBlock.list({
        path: { document_id: documentId },
        params: {
          page_size: Math.min(500, Math.max(20, maxBlocks - blocks.length)),
          ...(pageToken ? { page_token: pageToken } : {}),
        },
      }),
      "List document blocks",
    );
    blocks.push(...(data.items || []));
    hasMore = Boolean(data.has_more);
    pageToken = data.page_token;
    if (!pageToken) hasMore = false;
  }
  return { blocks: blocks.slice(0, maxBlocks), truncated: hasMore || blocks.length >= maxBlocks };
}

async function getBlock(client, documentId, blockId) {
  const data = assertApiResponse(
    await client.docx.documentBlock.get({ path: { document_id: documentId, block_id: blockId } }),
    `Get block ${blockId}`,
  );
  if (!data.block) throw new Error(`Block not found: ${blockId}`);
  return data.block;
}

async function getBlocksById(client, documentId, blockIds) {
  const blocks = [];
  const ids = Array.from(new Set(blockIds || [])).filter(Boolean);
  for (let index = 0; index < ids.length; index += 5) {
    const chunk = ids.slice(index, index + 5);
    const values = await Promise.all(
      chunk.map((blockId) => getBlock(client, documentId, blockId)),
    );
    blocks.push(...values);
    if (index + 5 < ids.length) {
      await new Promise((resolve) => setTimeout(resolve, 220));
    }
  }
  return blocks;
}

function allOccurrences(haystack, needle, caseSensitive) {
  if (!needle) return [];
  const source = caseSensitive ? haystack : haystack.toLocaleLowerCase();
  const query = caseSensitive ? needle : needle.toLocaleLowerCase();
  const ranges = [];
  let offset = 0;
  while (offset <= source.length - query.length) {
    const index = source.indexOf(query, offset);
    if (index === -1) break;
    ranges.push([index, index + query.length]);
    offset = index + Math.max(query.length, 1);
  }
  return ranges;
}

function requireString(value, name, { allowEmpty = false } = {}) {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    throw new Error(`${name} must be ${allowEmpty ? "a string" : "a non-empty string"}.`);
  }
  return value;
}

function requireBlockState(states, blockId) {
  const state = states.get(blockId);
  if (!state) throw new Error(`Block not loaded: ${blockId}`);
  return state;
}

function assertExpectedBlockText(state, operation) {
  if (operation.expectedBlockText === undefined) return;
  if (state.text !== operation.expectedBlockText) {
    const error = new Error(`Content conflict for block ${state.block.block_id}.`);
    error.code = "content_conflict";
    error.details = {
      blockId: state.block.block_id,
      expected: operation.expectedBlockText,
      actual: state.text,
    };
    throw error;
  }
}

function replaceNth(text, search, replacement, occurrence) {
  const ranges = allOccurrences(text, search, true);
  if (ranges.length === 0) throw new Error(`Text not found in block: ${search}`);
  if (occurrence === "all") {
    return { ranges };
  }
  const index = Number.isInteger(occurrence) && occurrence > 0 ? occurrence - 1 : 0;
  if (!ranges[index]) throw new Error(`Occurrence ${index + 1} not found for: ${search}`);
  return { ranges: [ranges[index]] };
}

async function applyBatchUpdates(client, documentId, states) {
  const changedStates = Array.from(states.values()).filter((state) => state.changed);
  const requests = changedStates.map((state) => ({
    block_id: state.block.block_id,
    update_text_elements: { elements: normalizeElements(state.elements) },
  }));

  const responses = [];
  for (let index = 0; index < requests.length; index += 50) {
    const chunk = requests.slice(index, index + 50);
    const data = assertApiResponse(
      await runLarkWrite(() => client.docx.documentBlock.batchUpdate({
        path: { document_id: documentId },
        data: { requests: chunk },
      })),
      "Batch update document blocks",
    );
    responses.push({
      requestCount: chunk.length,
      revisionId: data.document_revision_id,
      clientToken: data.client_token,
    });
    if (index + 50 < requests.length) await new Promise((resolve) => setTimeout(resolve, 350));
  }
  return { changedStates, responses };
}

async function verifyChangedBlocks(client, documentId, changedStates) {
  const verified = [];
  for (const state of changedStates.slice(0, 20)) {
    const block = await getBlock(client, documentId, state.block.block_id);
    const actual = blockText(block);
    verified.push({
      blockId: state.block.block_id,
      expected: state.text,
      actual,
      ok: actual === state.text,
    });
  }
  return verified;
}


const INSERTABLE_BLOCK_TYPES = Object.freeze({
  text: { blockType: 2, key: "text", richText: true },
  heading1: { blockType: 3, key: "heading1", richText: true },
  heading2: { blockType: 4, key: "heading2", richText: true },
  heading3: { blockType: 5, key: "heading3", richText: true },
  heading4: { blockType: 6, key: "heading4", richText: true },
  heading5: { blockType: 7, key: "heading5", richText: true },
  heading6: { blockType: 8, key: "heading6", richText: true },
  heading7: { blockType: 9, key: "heading7", richText: true },
  heading8: { blockType: 10, key: "heading8", richText: true },
  heading9: { blockType: 11, key: "heading9", richText: true },
  bullet: { blockType: 12, key: "bullet", richText: true },
  ordered: { blockType: 13, key: "ordered", richText: true },
  code: { blockType: 14, key: "code", richText: true },
  quote: { blockType: 15, key: "quote", richText: true },
  equation: { blockType: 16, key: "equation", richText: true },
  todo: { blockType: 17, key: "todo", richText: true },
  callout: { blockType: 19, key: "callout" },
  divider: { blockType: 22, key: "divider" },
  file: { blockType: 23, key: "file" },
  image: { blockType: 27, key: "image" },
  table: { blockType: 31, key: "table" },
});

const INLINE_STYLE_KEYS = Object.freeze({
  bold: "bold",
  italic: "italic",
  strikethrough: "strikethrough",
  underline: "underline",
  inlineCode: "inline_code",
  backgroundColor: "background_color",
  textColor: "text_color",
});

function toInlineStyle(input) {
  if (!input || typeof input !== "object") return undefined;
  const style = {};
  for (const [source, target] of Object.entries(INLINE_STYLE_KEYS)) {
    if (input[source] !== undefined) style[target] = input[source];
  }
  if (input.link) style.link = { url: String(input.link) };
  return Object.keys(style).length > 0 ? style : undefined;
}

function toBlockStyle(input, descriptor = {}) {
  if (!input && descriptor.done === undefined && descriptor.language === undefined) return undefined;
  const source = input || {};
  const style = {};
  if (source.align !== undefined) style.align = source.align;
  if (source.done !== undefined) style.done = source.done;
  else if (descriptor.done !== undefined) style.done = descriptor.done;
  if (source.folded !== undefined) style.folded = source.folded;
  if (source.language !== undefined) style.language = source.language;
  else if (descriptor.language !== undefined) style.language = descriptor.language;
  if (source.wrap !== undefined) style.wrap = source.wrap;
  if (source.backgroundColor !== undefined) style.background_color = source.backgroundColor;
  if (source.indentationLevel !== undefined) style.indentation_level = source.indentationLevel;
  return Object.keys(style).length > 0 ? style : undefined;
}

function buildRichTextElements(descriptor) {
  const runs = Array.isArray(descriptor.runs) && descriptor.runs.length > 0
    ? descriptor.runs
    : [{ kind: "text", text: descriptor.text ?? "", style: descriptor.textStyle }];

  return runs.map((run) => {
    const kind = run.kind || "text";
    const textElementStyle = toInlineStyle(run.style);
    if (kind === "text") {
      return { text_run: { content: String(run.text ?? ""), ...(textElementStyle ? { text_element_style: textElementStyle } : {}) } };
    }
    if (kind === "mention_user") {
      if (!run.userId) throw new Error("mention_user run requires userId.");
      return { mention_user: { user_id: String(run.userId), ...(textElementStyle ? { text_element_style: textElementStyle } : {}) } };
    }
    if (kind === "mention_doc") {
      if (!run.token || !Number.isInteger(run.objType)) throw new Error("mention_doc run requires token and integer objType.");
      return { mention_doc: {
        token: String(run.token),
        obj_type: run.objType,
        ...(run.url ? { url: String(run.url) } : {}),
        ...(run.title ? { title: String(run.title) } : {}),
        ...(run.fallbackType ? { fallback_type: run.fallbackType } : {}),
        ...(textElementStyle ? { text_element_style: textElementStyle } : {}),
      } };
    }
    if (kind === "equation") {
      return { equation: { content: String(run.text ?? ""), ...(textElementStyle ? { text_element_style: textElementStyle } : {}) } };
    }
    if (kind === "link_preview") {
      if (!run.url) throw new Error("link_preview run requires url.");
      return { link_preview: {
        url: String(run.url),
        url_type: run.urlType || "Undefined",
        ...(run.title ? { title: String(run.title) } : {}),
        ...(textElementStyle ? { text_element_style: textElementStyle } : {}),
      } };
    }
    throw new Error(`Unsupported rich-text run kind: ${kind}`);
  });
}

function buildApiBlock(descriptor) {
  const type = String(descriptor?.type || "");
  const spec = INSERTABLE_BLOCK_TYPES[type];
  if (!spec) throw new Error(`Unsupported insert block type: ${type}`);
  const block = { block_type: spec.blockType };

  if (spec.richText) {
    block[spec.key] = {
      ...(toBlockStyle(descriptor.style, descriptor) ? { style: toBlockStyle(descriptor.style, descriptor) } : {}),
      elements: buildRichTextElements(descriptor),
    };
    return block;
  }

  if (type === "callout") {
    block.callout = {
      ...(descriptor.backgroundColor !== undefined ? { background_color: descriptor.backgroundColor } : {}),
      ...(descriptor.borderColor !== undefined ? { border_color: descriptor.borderColor } : {}),
      ...(descriptor.textColor !== undefined ? { text_color: descriptor.textColor } : {}),
    };
    return block;
  }
  if (type === "divider") {
    block.divider = {};
    return block;
  }
  if (type === "image") {
    block.image = {
      ...(descriptor.align !== undefined ? { align: descriptor.align } : {}),
      ...(descriptor.caption !== undefined ? { caption: { content: String(descriptor.caption) } } : {}),
      ...(descriptor.scale !== undefined ? { scale: descriptor.scale } : {}),
    };
    return block;
  }
  if (type === "file") {
    block.file = { ...(descriptor.viewType !== undefined ? { view_type: descriptor.viewType } : {}) };
    return block;
  }
  if (type === "table") {
    const rows = Array.isArray(descriptor.rows) ? descriptor.rows : null;
    const rowSize = rows ? rows.length : descriptor.rowSize;
    const columnSize = rows && rows.length > 0
      ? Math.max(...rows.map((row) => Array.isArray(row) ? row.length : 0))
      : descriptor.columnSize;
    if (!Number.isInteger(rowSize) || rowSize < 1 || !Number.isInteger(columnSize) || columnSize < 1) {
      throw new Error("table requires non-empty rows or positive rowSize/columnSize.");
    }
    block.table = { property: {
      row_size: rowSize,
      column_size: columnSize,
      ...(Array.isArray(descriptor.columnWidths) ? { column_width: descriptor.columnWidths } : {}),
      ...(descriptor.headerRow !== undefined ? { header_row: descriptor.headerRow } : {}),
      ...(descriptor.headerColumn !== undefined ? { header_column: descriptor.headerColumn } : {}),
    } };
    return block;
  }
  throw new Error(`Unhandled insert block type: ${type}`);
}

function applyInlineStyle(elements, start, end, stylePatch) {
  const current = flatText(elements);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > current.length) {
    throw new Error(`Invalid format range ${start}..${end} for block length ${current.length}.`);
  }
  const patch = toInlineStyle(stylePatch || {}) || {};
  let cursor = 0;
  const output = [];
  for (const element of elements) {
    const content = element.text_run.content;
    const segStart = cursor;
    const segEnd = cursor + content.length;
    const oldStyle = cloneJson(element.text_run.text_element_style || {});
    const parts = [segStart, Math.max(segStart, start), Math.min(segEnd, end), segEnd]
      .filter((value, index, array) => value >= segStart && value <= segEnd && (index === 0 || value !== array[index - 1]));
    for (let i = 0; i < parts.length - 1; i += 1) {
      const partStart = parts[i];
      const partEnd = parts[i + 1];
      if (partEnd <= partStart) continue;
      const inside = partStart >= start && partEnd <= end;
      const nextStyle = inside ? { ...oldStyle, ...patch } : oldStyle;
      for (const [key, value] of Object.entries(nextStyle)) {
        if (value === null) delete nextStyle[key];
      }
      output.push({ text_run: {
        content: content.slice(partStart - segStart, partEnd - segStart),
        ...(Object.keys(nextStyle).length > 0 ? { text_element_style: nextStyle } : {}),
      } });
    }
    cursor = segEnd;
  }
  return normalizeElements(output);
}


function fitItemsWithinBudget(items, maxChars) {
  const fitted = [];
  let usedChars = 2;
  for (const item of items) {
    const size = JSON.stringify(item).length + 1;
    if (fitted.length > 0 && usedChars + size > maxChars) break;
    fitted.push(item);
    usedChars += size;
  }
  return { items: fitted, outputTruncated: fitted.length < items.length, estimatedChars: usedChars };
}

function blockDetails(block, maxText = 600) {
  const summary = blockSummary(block, maxText);
  return {
    ...summary,
    children: Array.isArray(block?.children) ? block.children : [],
    textStyle: cloneJson(textContainer(block)?.value?.style || null),
    callout: cloneJson(block?.callout || null),
    image: cloneJson(block?.image || null),
    file: cloneJson(block?.file || null),
    table: cloneJson(block?.table || null),
  };
}

async function listChildren(client, documentId, blockId, { maxBlocks = 500, withDescendants = false } = {}) {
  const blocks = [];
  let pageToken;
  let hasMore = true;
  while (hasMore && blocks.length < maxBlocks) {
    const data = assertApiResponse(
      await client.docx.documentBlockChildren.get({
        path: { document_id: documentId, block_id: blockId },
        params: {
          page_size: Math.min(500, Math.max(20, maxBlocks - blocks.length)),
          with_descendants: Boolean(withDescendants),
          ...(pageToken ? { page_token: pageToken } : {}),
        },
      }),
      `Get children for block ${blockId}`,
    );
    blocks.push(...(data.items || []));
    hasMore = Boolean(data.has_more);
    pageToken = data.page_token;
    if (!pageToken) hasMore = false;
  }
  return { blocks: blocks.slice(0, maxBlocks), truncated: hasMore || blocks.length >= maxBlocks };
}

async function uploadDocxMedia(client, documentId, filePath, kind) {
  const absolutePath = path.resolve(String(filePath || ""));
  const stat = fs.statSync(absolutePath);
  if (!stat.isFile()) throw new Error(`Not a regular file: ${absolutePath}`);
  if (stat.size > 20 * 1024 * 1024) throw new Error("Lark direct media upload in this adapter is limited to 20 MB per file.");
  const uploaded = await runLarkWrite(() => client.drive.media.uploadAll({ data: {
    file_name: path.basename(absolutePath),
    parent_type: kind === "image" ? "docx_image" : "docx_file",
    parent_node: documentId,
    size: stat.size,
    file: fs.createReadStream(absolutePath),
  } }));
  if (!uploaded?.file_token) throw new Error(`Upload ${kind} returned no file_token.`);
  return { token: uploaded.file_token, absolutePath, size: stat.size };
}

async function batchUpdateRequests(client, documentId, requests) {
  const batches = [];
  for (let index = 0; index < requests.length; index += 50) {
    const chunk = requests.slice(index, index + 50);
    const data = assertApiResponse(
      await runLarkWrite(() => client.docx.documentBlock.batchUpdate({
        path: { document_id: documentId },
        data: { requests: chunk },
      })),
      "Batch update document blocks",
    );
    batches.push({ requestCount: chunk.length, revisionId: data.document_revision_id, clientToken: data.client_token });
    if (index + 50 < requests.length) await new Promise((resolve) => setTimeout(resolve, 350));
  }
  return batches;
}

async function fillCreatedTable(client, documentId, tableBlock, descriptor) {
  if (!Array.isArray(descriptor.rows) || descriptor.rows.length === 0) return [];
  const cellIds = Array.isArray(tableBlock?.children) ? tableBlock.children : [];
  const columnSize = tableBlock?.table?.property?.column_size || Math.max(...descriptor.rows.map((row) => row.length));
  const createdCells = [];
  for (let rowIndex = 0; rowIndex < descriptor.rows.length; rowIndex += 1) {
    const row = descriptor.rows[rowIndex] || [];
    for (let columnIndex = 0; columnIndex < columnSize; columnIndex += 1) {
      const value = row[columnIndex];
      if (value === undefined || value === null || String(value) === "") continue;
      const cellId = cellIds[rowIndex * columnSize + columnIndex];
      if (!cellId) throw new Error(`Table cell ID missing for row ${rowIndex}, column ${columnIndex}.`);
      const data = assertApiResponse(
        await runLarkWrite(() => client.docx.documentBlockChildren.create({
          path: { document_id: documentId, block_id: cellId },
          data: { children: [buildApiBlock({ type: "text", text: String(value) })] },
        })),
        `Fill table cell ${cellId}`,
      );
      createdCells.push({ row: rowIndex, column: columnIndex, cellId, blockId: data.children?.[0]?.block_id || null });
    }
  }
  return createdCells;
}

async function createStructuredBlocks(client, documentId, parentBlockId, descriptors, index) {
  const blocks = descriptors.map(buildApiBlock);
  const data = assertApiResponse(
    await runLarkWrite(() => client.docx.documentBlockChildren.create({
      path: { document_id: documentId, block_id: parentBlockId || documentId },
      data: { children: blocks, ...(Number.isInteger(index) ? { index } : {}) },
    })),
    `Create child blocks under ${parentBlockId || documentId}`,
  );
  const created = data.children || [];
  const outcomes = [];

  for (let i = 0; i < descriptors.length; i += 1) {
    const descriptor = descriptors[i];
    const block = created[i];
    if (!block?.block_id) throw new Error(`Lark did not return block_id for created block index ${i}.`);
    const outcome = { index: i, type: descriptor.type, blockId: block.block_id, children: [] };

    if (descriptor.type === "image" && (descriptor.filePath || descriptor.fileToken)) {
      const media = descriptor.fileToken
        ? { token: descriptor.fileToken }
        : await uploadDocxMedia(client, documentId, descriptor.filePath, "image");
      outcome.media = media;
      outcome.mediaBatches = await batchUpdateRequests(client, documentId, [{
        block_id: block.block_id,
        replace_image: {
          token: media.token,
          ...(descriptor.width !== undefined ? { width: descriptor.width } : {}),
          ...(descriptor.height !== undefined ? { height: descriptor.height } : {}),
          ...(descriptor.align !== undefined ? { align: descriptor.align } : {}),
          ...(descriptor.caption !== undefined ? { caption: { content: String(descriptor.caption) } } : {}),
          ...(descriptor.scale !== undefined ? { scale: descriptor.scale } : {}),
        },
      }]);
    }

    if (descriptor.type === "file" && (descriptor.filePath || descriptor.fileToken)) {
      const media = descriptor.fileToken
        ? { token: descriptor.fileToken }
        : await uploadDocxMedia(client, documentId, descriptor.filePath, "file");
      outcome.media = media;
      outcome.mediaBatches = await batchUpdateRequests(client, documentId, [{
        block_id: block.block_id,
        replace_file: { token: media.token },
      }]);
    }

    if (descriptor.type === "table") {
      outcome.tableCells = await fillCreatedTable(client, documentId, block, descriptor);
    }

    if (Array.isArray(descriptor.children) && descriptor.children.length > 0) {
      outcome.children = await createStructuredBlocks(client, documentId, block.block_id, descriptor.children);
    }
    outcomes.push(outcome);
  }
  return outcomes;
}


function validateLocalMediaPath(filePath) {
  if (!filePath) return;
  const absolutePath = path.resolve(String(filePath));
  const stat = fs.statSync(absolutePath);
  if (!stat.isFile()) throw new Error(`Not a regular file: ${absolutePath}`);
  if (stat.size > 20 * 1024 * 1024) throw new Error(`Media file exceeds 20 MB direct-upload limit: ${absolutePath}`);
}

function validateBlockDescriptors(descriptors) {
  for (const descriptor of descriptors || []) {
    buildApiBlock(descriptor);
    if ((descriptor.type === "image" || descriptor.type === "file") && descriptor.filePath) {
      validateLocalMediaPath(descriptor.filePath);
    }
    if (Array.isArray(descriptor.children)) validateBlockDescriptors(descriptor.children);
  }
}

async function preflightOperations(client, documentId, operations) {
  const tableOps = new Set([
    "insert_table_row", "insert_table_column", "delete_table_rows", "delete_table_columns",
    "merge_table_cells", "unmerge_table_cells", "update_table_property",
  ]);
  const directIds = new Set();
  for (const operation of operations) {
    if (operation.op === "insert_blocks") {
      if (!Array.isArray(operation.blocks) || operation.blocks.length === 0) throw new Error("insert_blocks requires blocks.");
      validateBlockDescriptors(operation.blocks);
      if (operation.parentBlockId) directIds.add(operation.parentBlockId);
    } else if (operation.op === "delete_blocks") {
      if (!Array.isArray(operation.blockIds) || operation.blockIds.length === 0) throw new Error("delete_blocks requires blockIds.");
      for (const id of operation.blockIds) directIds.add(id);
    } else if (tableOps.has(operation.op) || operation.op === "replace_image" || operation.op === "replace_file") {
      if (!operation.blockId) throw new Error(`${operation.op} requires blockId.`);
      directIds.add(operation.blockId);
      if ((operation.op === "replace_image" || operation.op === "replace_file") && !operation.fileToken) {
        validateLocalMediaPath(operation.filePath);
      }
    }
  }
  const loaded = directIds.size > 0 ? await getBlocksById(client, documentId, [...directIds]) : [];
  const byId = new Map(loaded.map((block) => [block.block_id, block]));
  for (const operation of operations) {
    if (tableOps.has(operation.op)) {
      const block = byId.get(operation.blockId);
      if (blockTypeName(block) !== "table") throw new Error(`${operation.op} target ${operation.blockId} is not a table block.`);
    }
    if (operation.op === "replace_image" && blockTypeName(byId.get(operation.blockId)) !== "image") {
      throw new Error(`replace_image target ${operation.blockId} is not an image block.`);
    }
    if (operation.op === "replace_file" && blockTypeName(byId.get(operation.blockId)) !== "file") {
      throw new Error(`replace_file target ${operation.blockId} is not a file block.`);
    }
  }
}

async function deleteBlocksById(client, documentId, blockIds) {
  const blocks = await getBlocksById(client, documentId, blockIds);
  const groups = new Map();
  for (const block of blocks) {
    if (!block.parent_id) throw new Error(`Block ${block.block_id} has no parent_id and cannot be deleted by child range.`);
    if (!groups.has(block.parent_id)) groups.set(block.parent_id, []);
    groups.get(block.parent_id).push(block.block_id);
  }
  const deleted = [];
  for (const [parentId, ids] of groups) {
    const { blocks: children } = await listChildren(client, documentId, parentId, { maxBlocks: 2000 });
    const indexMap = new Map(children.map((child, index) => [child.block_id, index]));
    const indexes = ids.map((id) => {
      if (!indexMap.has(id)) throw new Error(`Block ${id} is not a direct child of ${parentId}.`);
      return indexMap.get(id);
    }).sort((a, b) => a - b);
    const runs = [];
    for (const value of indexes) {
      const last = runs.at(-1);
      if (last && value === last.end) last.end += 1;
      else runs.push({ start: value, end: value + 1 });
    }
    for (const run of runs.reverse()) {
      const data = assertApiResponse(
        await runLarkWrite(() => client.docx.documentBlockChildren.batchDelete({
          path: { document_id: documentId, block_id: parentId },
          data: { start_index: run.start, end_index: run.end },
        })),
        `Delete child block range ${parentId}:${run.start}..${run.end}`,
      );
      deleted.push({ parentId, startIndex: run.start, endIndex: run.end, revisionId: data.document_revision_id });
    }
  }
  return deleted;
}

export function registerLarkAdapter({ server, z, getContext, clientFactory = null, sendToExtension = null }) {
  const resolveClient = async (context) => clientFactory ? clientFactory(context) : getClient(context);
  const sessionBackend = sendToExtension ? createLarkBrowserSessionBackend({ sendToExtension }) : null;

  function chooseBackend(context, args = {}) {
    const requested = args.backend || "auto";
    if (requested === "browser_session") {
      if (args.documentId) return { type: "error", payload: fail("Browser Session Backend 只能操作当前打开的 Lark 文档，不能使用显式 documentId。", { code: "session_explicit_document_unsupported" }) };
      if (!sessionBackend) return { type: "error", payload: fail("Browser Session Backend 未接入当前 MCP Server。", { code: "session_backend_unavailable" }) };
      return { type: "browser_session" };
    }
    if (requested === "openapi") return { type: "openapi" };
    if (args.documentId) return { type: "openapi" };

    // Browser-native default: when the user is actively on a Lark document,
    // prefer the current authenticated browser session. A stale or invalid
    // local OpenAPI config must not hijack the current-document fast path.
    if (sessionBackend && isLarkDocumentContext(context)) return { type: "browser_session" };

    const config = readConfig();
    if (config.configured) return { type: "openapi" };
    return { type: "openapi" };
  }

  function wrapBackendPayload(payload) {
    return result(payload, payload?.ok === false);
  }

  function inactiveResult(context, explicitDocumentId) {
    if (explicitDocumentId || isLarkDocumentContext(context)) return null;
    return fail("Lark structured capability is inactive for the current page.", {
      code: "capability_inactive",
      capability: "lark",
      currentUrl: context?.url || "",
      supportedPages: [
        "*.larksuite.com/docx/*",
        "*.larksuite.com/wiki/* (Docx nodes)",
        "*.feishu.cn/docx/*",
        "*.feishu.cn/wiki/* (Docx nodes)",
        "*.larksuite.com/docs/* (Browser Session backend)",
        "*.feishu.cn/docs/* (Browser Session backend)",
      ],
    });
  }

  const textRunSchema = z.object({
    kind: z.enum(["text", "mention_user", "mention_doc", "equation", "link_preview"]).optional(),
    text: z.string().optional(),
    userId: z.string().optional(),
    token: z.string().optional(),
    objType: z.number().int().optional(),
    url: z.string().optional(),
    title: z.string().optional(),
    fallbackType: z.enum(["FallbackToLink", "FallbackToText"]).optional(),
    urlType: z.enum(["Project", "Undefined"]).optional(),
    style: z.object({
      bold: z.boolean().nullable().optional(),
      italic: z.boolean().nullable().optional(),
      strikethrough: z.boolean().nullable().optional(),
      underline: z.boolean().nullable().optional(),
      inlineCode: z.boolean().nullable().optional(),
      backgroundColor: z.number().nullable().optional(),
      textColor: z.number().nullable().optional(),
      link: z.string().nullable().optional(),
    }).optional(),
  });

  const blockDescriptorSchema = z.lazy(() => z.object({
    type: z.enum([
      "text", "heading1", "heading2", "heading3", "heading4", "heading5", "heading6", "heading7", "heading8", "heading9",
      "bullet", "ordered", "code", "quote", "equation", "todo", "callout", "divider", "image", "file", "table",
    ]),
    text: z.string().optional(),
    runs: z.array(textRunSchema).max(200).optional(),
    textStyle: textRunSchema.shape.style.optional(),
    style: z.object({
      align: z.number().int().optional(),
      done: z.boolean().optional(),
      folded: z.boolean().optional(),
      language: z.number().int().optional(),
      wrap: z.boolean().optional(),
      backgroundColor: z.enum([
        "LightGrayBackground", "LightRedBackground", "LightOrangeBackground", "LightYellowBackground", "LightGreenBackground", "LightBlueBackground", "LightPurpleBackground",
        "PaleGrayBackground", "DarkGrayBackground", "DarkRedBackground", "DarkOrangeBackground", "DarkYellowBackground", "DarkGreenBackground", "DarkBlueBackground", "DarkPurpleBackground",
      ]).optional(),
      indentationLevel: z.enum(["NoIndent", "OneLevelIndent"]).optional(),
    }).optional(),
    done: z.boolean().optional(),
    language: z.number().int().optional(),
    backgroundColor: z.number().int().optional(),
    borderColor: z.number().int().optional(),
    textColor: z.number().int().optional(),
    align: z.number().int().optional(),
    caption: z.string().optional(),
    scale: z.number().optional(),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    filePath: z.string().optional(),
    fileToken: z.string().optional(),
    viewType: z.number().int().optional(),
    rows: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).max(50)).max(100).optional(),
    rowSize: z.number().int().min(1).max(100).optional(),
    columnSize: z.number().int().min(1).max(50).optional(),
    columnWidths: z.array(z.number().int().positive()).max(50).optional(),
    headerRow: z.boolean().optional(),
    headerColumn: z.boolean().optional(),
    children: z.array(blockDescriptorSchema).max(100).optional(),
  }));

  const readTool = server.tool(
    "lark_read",
    "Read the current Lark/Feishu document through the best available backend. For the current opened Lark document, auto mode prefers the logged-in Browser Session without exporting cookies; explicit documentId or backend=openapi uses OpenAPI. Scopes: outline, document, blocks, children, tree. Do not use for ordinary webpages.",
    {
      scope: z.enum(["outline", "document", "blocks", "children", "tree"]).default("outline"),
      blockIds: z.array(z.string()).max(100).optional(),
      parentBlockId: z.string().optional(),
      withDescendants: z.boolean().optional(),
      maxBlocks: z.number().int().min(1).max(2000).optional(),
      maxChars: z.number().int().min(200).max(50000).optional(),
      documentId: z.string().optional(),
      backend: z.enum(["auto", "openapi", "browser_session"]).optional(),
    },
    async (args) => {
      try {
        const context = getContext();
        const inactive = inactiveResult(context, args.documentId);
        if (inactive) return inactive;
        const backend = chooseBackend(context, args);
        if (backend.type === "error") return backend.payload;
        if (backend.type === "browser_session") return wrapBackendPayload(await sessionBackend.read(context, args));
        const client = await resolveClient(context);
        const ref = await resolveDocument(client, context, args.documentId);
        const document = await getDocumentMeta(client, ref.documentId);
        const documentInfo = { documentId: ref.documentId, title: document.title || "", revisionId: document.revision_id ?? null };

        if (args.scope === "document") {
          const maxChars = args.maxChars || 12000;
          const data = assertApiResponse(
            await client.docx.document.rawContent({ path: { document_id: ref.documentId } }),
            "Read document plain text",
          );
          const content = data.content || "";
          return result({ ok: true, source: ref.source, document: documentInfo, content: content.slice(0, maxChars), totalChars: content.length, truncated: content.length > maxChars });
        }

        if (args.scope === "blocks") {
          const ids = Array.from(new Set(args.blockIds || [])).filter(Boolean);
          if (ids.length === 0) return fail("scope=blocks requires blockIds.");
          const blocks = await getBlocksById(client, ref.documentId, ids);
          const payload = fitItemsWithinBudget(
            blocks.map((block) => ({ ...blockDetails(block, 2000), rawElements: cloneJson(textContainer(block)?.value?.elements || null) })),
            args.maxChars || 30000,
          );
          return result({ ok: true, source: ref.source, document: documentInfo, blocks: payload.items, outputTruncated: payload.outputTruncated, estimatedChars: payload.estimatedChars });
        }

        if (args.scope === "children") {
          const parentBlockId = args.parentBlockId || ref.documentId;
          const { blocks, truncated } = await listChildren(client, ref.documentId, parentBlockId, { maxBlocks: args.maxBlocks || 300, withDescendants: Boolean(args.withDescendants) });
          const payload = fitItemsWithinBudget(blocks.map((block) => blockDetails(block, 400)), args.maxChars || 20000);
          return result({ ok: true, source: ref.source, document: documentInfo, parentBlockId, withDescendants: Boolean(args.withDescendants), blocks: payload.items, truncated: truncated || payload.outputTruncated, outputTruncated: payload.outputTruncated, estimatedChars: payload.estimatedChars });
        }

        const { blocks, truncated } = await listBlocks(client, ref.documentId, args.maxBlocks || (args.scope === "tree" ? 500 : 160));
        if (args.scope === "tree") {
          const payload = fitItemsWithinBudget(blocks.map((block) => blockDetails(block, 240)), args.maxChars || 20000);
          return result({ ok: true, source: ref.source, document: documentInfo, blocks: payload.items, truncated: truncated || payload.outputTruncated, outputTruncated: payload.outputTruncated, estimatedChars: payload.estimatedChars });
        }
        const outlineItems = blocks.filter((block) => blockText(block) || block?.children?.length || ["heading1", "heading2", "heading3", "heading4", "table", "callout", "image", "file", "divider"].includes(blockTypeName(block))).map((block) => blockSummary(block, 180));
        const payload = fitItemsWithinBudget(outlineItems, args.maxChars || 12000);
        return result({
          ok: true,
          source: ref.source,
          document: documentInfo,
          blocks: payload.items,
          truncated: truncated || payload.outputTruncated,
          outputTruncated: payload.outputTruncated,
          estimatedChars: payload.estimatedChars,
        });
      } catch (error) {
        return fail(error?.message || String(error), error?.details || {});
      }
    },
  );

  const searchTool = server.tool(
    "lark_search",
    "Search the current Lark/Feishu document and return backend-stable block IDs plus visible-text ranges and bounded match contexts. For the current opened Lark document, auto mode prefers the logged-in Browser Session; explicit documentId or backend=openapi uses OpenAPI. Use this for discovery or ambiguous targets; a unique simple edit can go directly to lark_patch without a separate search call.",
    {
      query: z.string().min(1),
      caseSensitive: z.boolean().optional(),
      blockTypes: z.array(z.string()).max(30).optional(),
      limit: z.number().int().min(1).max(50).optional(),
      maxBlocks: z.number().int().min(1).max(2000).optional(),
      documentId: z.string().optional(),
      backend: z.enum(["auto", "openapi", "browser_session"]).optional(),
    },
    async (args) => {
      try {
        const context = getContext();
        const inactive = inactiveResult(context, args.documentId);
        if (inactive) return inactive;
        const backend = chooseBackend(context, args);
        if (backend.type === "error") return backend.payload;
        if (backend.type === "browser_session") return wrapBackendPayload(await sessionBackend.search(context, args));
        const client = await resolveClient(context);
        const ref = await resolveDocument(client, context, args.documentId);
        const limit = args.limit || 20;
        const allowedTypes = new Set(args.blockTypes || []);
        const { blocks, truncated } = await listBlocks(client, ref.documentId, args.maxBlocks || 1000);
        const matches = [];
        for (const block of blocks) {
          const type = blockTypeName(block);
          if (allowedTypes.size > 0 && !allowedTypes.has(type)) continue;
          const text = blockText(block);
          if (!text) continue;
          const ranges = allOccurrences(text, args.query, Boolean(args.caseSensitive));
          if (ranges.length === 0) continue;
          matches.push({ blockId: block.block_id, parentId: block.parent_id || null, type, text: text.length > 500 ? `${text.slice(0, 500)}…` : text, textLength: text.length, ranges: ranges.slice(0, 20), editableTextOnly: textOnlyElementsSafe(block), children: block.children || [] });
          if (matches.length >= limit) break;
        }
        return result({ ok: true, documentId: ref.documentId, query: args.query, matches, resultLimitReached: matches.length >= limit, documentScanTruncated: truncated });
      } catch (error) {
        return fail(error?.message || String(error), error?.details || {});
      }
    },
  );

  const patchTool = server.tool(
    "lark_patch",
    "Apply Lark/Feishu document edits through the best available backend. For the current opened Lark document, auto mode prefers the logged-in Browser Session without exporting cookies; explicit documentId or backend=openapi uses full OpenAPI block APIs. Browser Session uses visible-text coordinates and internally handles zero-width characters, NBSP/line-ending normalization, stale session block IDs, exact read-back verification, and one bounded target re-resolution. For a unique current-document edit, prefer one lark_patch call: replace_text/delete_text/format_text may omit blockId when search is unique; insert_text may omit blockId when anchorText + position are provided. Do not lark_search first unless the target is ambiguous, and do not independently lark_read after a successful Browser Session patch that returns verificationComplete=true and callerRereadRequired=false. Existing complex table mutation remains OpenAPI-only. Prefer this over screenshot/click/type loops.",
    {
      operations: z.array(z.object({
        op: z.enum([
          "insert_text", "replace_text", "delete_text", "set_text", "replace_all", "format_text",
          "insert_blocks", "delete_blocks",
          "insert_table_row", "insert_table_column", "delete_table_rows", "delete_table_columns", "merge_table_cells", "unmerge_table_cells", "update_table_property",
          "replace_image", "replace_file",
        ]),
        blockId: z.string().optional(),
        blockIds: z.array(z.string()).max(200).optional(),
        parentBlockId: z.string().optional(),
        anchorBlockId: z.string().optional().describe("Browser Session insert_blocks anchor. Insert after/end of this current-page session block. OpenAPI ignores this field."),
        anchorText: z.string().optional().describe("Browser Session simple insert target. When insert_text omits blockId, use anchorText plus position=before|after. The adapter resolves one unique visible-text match internally."),
        position: z.enum(["before", "after"]).optional().describe("Position relative to anchorText for Browser Session insert_text. Defaults to after when anchorText is used."),
        caseSensitive: z.boolean().optional().describe("Browser Session visible-text matching case sensitivity for search/anchorText/replace operations."),
        preserveFormatting: z.boolean().optional().describe("Browser Session text safety guard. Defaults to true and refuses replacements that cross multiple formatting runs; set false only when flattening the selected inline formatting is intentional."),
        index: z.number().int().min(0).optional(),
        blocks: z.array(blockDescriptorSchema).max(100).optional(),
        offset: z.number().int().min(0).optional(),
        start: z.number().int().min(0).optional(),
        end: z.number().int().min(0).optional(),
        text: z.string().optional(),
        search: z.string().optional(),
        replacement: z.string().optional(),
        occurrence: z.union([z.number().int().min(1), z.literal("all")]).optional(),
        expectedText: z.string().optional(),
        expectedBlockText: z.string().optional().describe("Optional optimistic guard. In Browser Session mode this is compared in visible-text space, so Lark zero-width boundary markers and NBSP/line-ending normalization do not need to be copied into the guard. Unique simple edits normally do not need this field."),
        limit: z.number().int().min(1).max(500).optional(),
        style: textRunSchema.shape.style.optional(),
        rowIndex: z.number().int().min(0).optional(),
        columnIndex: z.number().int().min(0).optional(),
        rowStartIndex: z.number().int().min(0).optional(),
        rowEndIndex: z.number().int().min(0).optional(),
        columnStartIndex: z.number().int().min(0).optional(),
        columnEndIndex: z.number().int().min(0).optional(),
        columnWidth: z.number().int().positive().optional(),
        headerRow: z.boolean().optional(),
        headerColumn: z.boolean().optional(),
        filePath: z.string().optional(),
        fileToken: z.string().optional(),
        width: z.number().int().positive().optional(),
        height: z.number().int().positive().optional(),
        align: z.number().int().optional(),
        caption: z.string().optional(),
        scale: z.number().optional(),
      })).min(1).max(100),
      verify: z.boolean().optional().describe("OpenAPI compatibility flag. Browser Session always performs internal read-back verification and does not allow this flag to disable verification."),
      documentId: z.string().optional(),
      backend: z.enum(["auto", "openapi", "browser_session"]).optional(),
      maxBlocks: z.number().int().min(1).max(2000).optional(),
    },
    async (args) => {
      try {
        const context = getContext();
        const inactive = inactiveResult(context, args.documentId);
        if (inactive) return inactive;
        const backend = chooseBackend(context, args);
        if (backend.type === "error") return backend.payload;
        if (backend.type === "browser_session") return wrapBackendPayload(await sessionBackend.patch(context, args));
        const client = await resolveClient(context);
        const ref = await resolveDocument(client, context, args.documentId);
        await preflightOperations(client, ref.documentId, args.operations);
        const textOps = new Set(["insert_text", "replace_text", "delete_text", "set_text", "replace_all", "format_text"]);
        const states = new Map();
        const textBlockIds = new Set(args.operations.filter((operation) => textOps.has(operation.op) && operation.op !== "replace_all").map((operation) => operation.blockId).filter(Boolean));

        if (args.operations.some((operation) => operation.op === "replace_all")) {
          const { blocks } = await listBlocks(client, ref.documentId, 2000);
          for (const block of blocks) {
            if (!block.block_id || !textContainer(block)) continue;
            try {
              const elements = textOnlyElements(block);
              states.set(block.block_id, { block, elements, text: flatText(elements), changed: false });
            } catch {}
          }
        }
        for (const blockId of textBlockIds) {
          if (states.has(blockId)) continue;
          const block = await getBlock(client, ref.documentId, blockId);
          const elements = textOnlyElements(block);
          states.set(blockId, { block, elements, text: flatText(elements), changed: false });
        }

        const applied = [];
        const directBatchRequests = [];
        const created = [];
        const deleted = [];

        for (let operationIndex = 0; operationIndex < args.operations.length; operationIndex += 1) {
          const operation = args.operations[operationIndex];

          if (operation.op === "replace_all") {
            const search = requireString(operation.search, "search");
            const replacement = requireString(operation.replacement ?? "", "replacement", { allowEmpty: true });
            const limit = operation.limit || 500;
            let replacementCount = 0;
            const changedBlocks = [];
            for (const state of states.values()) {
              if (replacementCount >= limit) break;
              let ranges = allOccurrences(state.text, search, true);
              if (ranges.length === 0) continue;
              ranges = ranges.slice(0, Math.max(0, limit - replacementCount));
              for (let index = ranges.length - 1; index >= 0; index -= 1) {
                const [start, end] = ranges[index];
                state.elements = spliceElements(state.elements, start, end, replacement);
              }
              state.text = flatText(state.elements);
              state.changed = true;
              replacementCount += ranges.length;
              changedBlocks.push(state.block.block_id);
            }
            applied.push({ operationIndex, op: operation.op, replacements: replacementCount, changedBlocks, limitReached: replacementCount >= limit });
            continue;
          }

          if (textOps.has(operation.op)) {
            if (!operation.blockId) throw new Error(`${operation.op} requires blockId.`);
            const state = requireBlockState(states, operation.blockId);
            assertExpectedBlockText(state, operation);

            if (operation.op === "insert_text") {
              const text = requireString(operation.text ?? "", "text", { allowEmpty: true });
              if (!Number.isInteger(operation.offset)) throw new Error("insert_text requires integer offset.");
              state.elements = spliceElements(state.elements, operation.offset, operation.offset, text);
              state.text = flatText(state.elements);
              state.changed = true;
              applied.push({ operationIndex, op: operation.op, blockId: operation.blockId, offset: operation.offset, insertedChars: text.length });
              continue;
            }
            if (operation.op === "replace_text") {
              const search = requireString(operation.search, "search");
              const replacement = requireString(operation.replacement ?? "", "replacement", { allowEmpty: true });
              const outcome = replaceNth(state.text, search, replacement, operation.occurrence || 1);
              for (let index = outcome.ranges.length - 1; index >= 0; index -= 1) {
                const [start, end] = outcome.ranges[index];
                state.elements = spliceElements(state.elements, start, end, replacement);
              }
              state.text = flatText(state.elements);
              state.changed = true;
              applied.push({ operationIndex, op: operation.op, blockId: operation.blockId, replacements: outcome.ranges.length });
              continue;
            }
            if (operation.op === "delete_text") {
              if (!Number.isInteger(operation.start) || !Number.isInteger(operation.end)) throw new Error("delete_text requires integer start and end.");
              const actual = state.text.slice(operation.start, operation.end);
              if (operation.expectedText !== undefined && actual !== operation.expectedText) {
                const error = new Error(`Content conflict for text range in block ${operation.blockId}.`);
                error.code = "content_conflict";
                error.details = { blockId: operation.blockId, expected: operation.expectedText, actual };
                throw error;
              }
              state.elements = spliceElements(state.elements, operation.start, operation.end, "");
              state.text = flatText(state.elements);
              state.changed = true;
              applied.push({ operationIndex, op: operation.op, blockId: operation.blockId, deletedChars: operation.end - operation.start });
              continue;
            }
            if (operation.op === "set_text") {
              const text = requireString(operation.text ?? "", "text", { allowEmpty: true });
              state.elements = spliceElements(state.elements, 0, state.text.length, text);
              state.text = flatText(state.elements);
              state.changed = true;
              applied.push({ operationIndex, op: operation.op, blockId: operation.blockId, newLength: text.length });
              continue;
            }
            if (operation.op === "format_text") {
              if (!Number.isInteger(operation.start) || !Number.isInteger(operation.end)) throw new Error("format_text requires integer start and end.");
              state.elements = applyInlineStyle(state.elements, operation.start, operation.end, operation.style || {});
              state.text = flatText(state.elements);
              state.changed = true;
              applied.push({ operationIndex, op: operation.op, blockId: operation.blockId, start: operation.start, end: operation.end, style: operation.style || {} });
              continue;
            }
          }

          if (operation.op === "insert_blocks") {
            if (!Array.isArray(operation.blocks) || operation.blocks.length === 0) throw new Error("insert_blocks requires blocks.");
            const outcome = await createStructuredBlocks(client, ref.documentId, operation.parentBlockId || ref.documentId, operation.blocks, operation.index);
            created.push(...outcome);
            applied.push({ operationIndex, op: operation.op, parentBlockId: operation.parentBlockId || ref.documentId, created: outcome });
            continue;
          }

          if (operation.op === "delete_blocks") {
            if (!Array.isArray(operation.blockIds) || operation.blockIds.length === 0) throw new Error("delete_blocks requires blockIds.");
            const outcome = await deleteBlocksById(client, ref.documentId, operation.blockIds);
            deleted.push(...outcome);
            applied.push({ operationIndex, op: operation.op, blockIds: operation.blockIds, ranges: outcome });
            continue;
          }

          if (!operation.blockId) throw new Error(`${operation.op} requires blockId.`);
          const request = { block_id: operation.blockId };
          if (operation.op === "insert_table_row") {
            if (!Number.isInteger(operation.rowIndex)) throw new Error("insert_table_row requires rowIndex.");
            request.insert_table_row = { row_index: operation.rowIndex };
          } else if (operation.op === "insert_table_column") {
            if (!Number.isInteger(operation.columnIndex)) throw new Error("insert_table_column requires columnIndex.");
            request.insert_table_column = { column_index: operation.columnIndex };
          } else if (operation.op === "delete_table_rows") {
            if (!Number.isInteger(operation.rowStartIndex) || !Number.isInteger(operation.rowEndIndex)) throw new Error("delete_table_rows requires rowStartIndex and rowEndIndex.");
            request.delete_table_rows = { row_start_index: operation.rowStartIndex, row_end_index: operation.rowEndIndex };
          } else if (operation.op === "delete_table_columns") {
            if (!Number.isInteger(operation.columnStartIndex) || !Number.isInteger(operation.columnEndIndex)) throw new Error("delete_table_columns requires columnStartIndex and columnEndIndex.");
            request.delete_table_columns = { column_start_index: operation.columnStartIndex, column_end_index: operation.columnEndIndex };
          } else if (operation.op === "merge_table_cells") {
            for (const name of ["rowStartIndex", "rowEndIndex", "columnStartIndex", "columnEndIndex"]) if (!Number.isInteger(operation[name])) throw new Error(`merge_table_cells requires ${name}.`);
            request.merge_table_cells = { row_start_index: operation.rowStartIndex, row_end_index: operation.rowEndIndex, column_start_index: operation.columnStartIndex, column_end_index: operation.columnEndIndex };
          } else if (operation.op === "unmerge_table_cells") {
            if (!Number.isInteger(operation.rowIndex) || !Number.isInteger(operation.columnIndex)) throw new Error("unmerge_table_cells requires rowIndex and columnIndex.");
            request.unmerge_table_cells = { row_index: operation.rowIndex, column_index: operation.columnIndex };
          } else if (operation.op === "update_table_property") {
            request.update_table_property = {
              ...(operation.columnWidth !== undefined ? { column_width: operation.columnWidth } : {}),
              ...(operation.columnIndex !== undefined ? { column_index: operation.columnIndex } : {}),
              ...(operation.headerRow !== undefined ? { header_row: operation.headerRow } : {}),
              ...(operation.headerColumn !== undefined ? { header_column: operation.headerColumn } : {}),
            };
            if (Object.keys(request.update_table_property).length === 0) throw new Error("update_table_property requires at least one property.");
          } else if (operation.op === "replace_image") {
            const media = operation.fileToken ? { token: operation.fileToken } : await uploadDocxMedia(client, ref.documentId, operation.filePath, "image");
            request.replace_image = {
              token: media.token,
              ...(operation.width !== undefined ? { width: operation.width } : {}),
              ...(operation.height !== undefined ? { height: operation.height } : {}),
              ...(operation.align !== undefined ? { align: operation.align } : {}),
              ...(operation.caption !== undefined ? { caption: { content: operation.caption } } : {}),
              ...(operation.scale !== undefined ? { scale: operation.scale } : {}),
            };
          } else if (operation.op === "replace_file") {
            const media = operation.fileToken ? { token: operation.fileToken } : await uploadDocxMedia(client, ref.documentId, operation.filePath, "file");
            request.replace_file = { token: media.token };
          } else {
            throw new Error(`Unhandled operation: ${operation.op}`);
          }
          directBatchRequests.push(request);
          applied.push({ operationIndex, op: operation.op, blockId: operation.blockId });
        }

        const { changedStates, responses: textBatches } = await applyBatchUpdates(client, ref.documentId, states);
        const directBatches = directBatchRequests.length > 0 ? await batchUpdateRequests(client, ref.documentId, directBatchRequests) : [];
        const verify = args.verify !== false;
        const verification = verify ? await verifyChangedBlocks(client, ref.documentId, changedStates) : [];
        const verificationFailed = verification.filter((item) => !item.ok);

        return result({
          ok: verificationFailed.length === 0,
          documentId: ref.documentId,
          applied,
          created,
          deleted,
          changedBlocks: changedStates.map((state) => ({ blockId: state.block.block_id, text: state.text })),
          batches: [...textBatches, ...directBatches],
          verification,
          ...(verificationFailed.length > 0 ? { error: "One or more text block verifications failed." } : {}),
        }, verificationFailed.length > 0);
      } catch (error) {
        return fail(error?.message || String(error), { code: error?.code || undefined, ...(error?.details || {}) });
      }
    },
  );

  readTool.__capabilityName = "lark_read";
  searchTool.__capabilityName = "lark_search";
  patchTool.__capabilityName = "lark_patch";
  return { id: "lark", matches: isLarkDocumentContext, tools: [readTool, searchTool, patchTool] };
}

function textOnlyElementsSafe(block) {
  try { textOnlyElements(block); return true; } catch { return false; }
}

export const __larkAdapterTest = Object.freeze({
  parseLarkPage,
  blockText,
  flatText,
  normalizeElements,
  spliceElements,
  allOccurrences,
  applyInlineStyle,
  buildApiBlock,
  buildRichTextElements,
});
