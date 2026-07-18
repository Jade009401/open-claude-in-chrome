#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const backgroundPath = path.join(here, "..", "extension", "background.js");
const background = fs.readFileSync(backgroundPath, "utf8");
const marker = "// --- Claude Sidebar Lark Browser Session backend v6.3 ---";
const start = background.indexOf(marker);
const end = background.indexOf("// --- Tool dispatch ---", start);
if (start < 0 || end < 0) {
  throw new Error("Patched Lark Browser Session block was not found in extension/background.js");
}
const snippet = background.slice(start, end);

if (snippet.includes("args.verify !== false")) {
  throw new Error("Browser Session still allows verification bypass through verify=false");
}

for (const requiredSource of [
  'coordinateSpace: "visible_text"',
  "callerRereadRequired: false",
  "verificationComplete: true",
  "stale_block_recovered",
  "ambiguous_text_target",
  "session_rich_text_boundary",
  "session_invalid_operation_shape",
  "adapter_no_op",
]) {
  if (!snippet.includes(requiredSource)) {
    throw new Error(`Simple Edit Fast Path source marker is missing: ${requiredSource}`);
  }
}

const context = {
  console,
  Map,
  Set,
  WeakMap,
  Array,
  Object,
  String,
  Number,
  Boolean,
  JSON,
  Math,
  Date,
  RegExp,
  Error,
  URL,
  Intl,
  toolHandlers: {},
  chrome: { tabs: { get: async () => ({ url: "https://puvrou0495.sg.larksuite.com/wiki/EoWCwavZziuXDSk1QCelp8SfgOb" }) } },
  isInGroup: async () => true,
  sleep: async () => {},
  ensureDomain: async () => {},
  cdp: async () => ({}),
};
vm.createContext(context);
vm.runInContext(
  snippet + "\nglobalThis.__simpleEditSmoke={toolHandlers,setEvaluate(fn){evaluateLarkSessionPage=fn},setReplace(fn){replacePreparedLarkSelection=fn}};",
  context,
);

function createHarness(initialBlocks) {
  let serial = 0;
  const blocks = initialBlocks.map((block, index) => ({
    id: block.id || `session:b${index + 1}`,
    text: block.text,
    type: block.type || "text",
  }));
  const aliases = new Map();
  const calls = [];
  let writeCount = 0;

  const currentBlock = (id) => {
    const resolved = aliases.get(id) || id;
    return blocks.find((block) => block.id === resolved) || null;
  };
  const ranges = (text, query) => {
    const result = [];
    let index = 0;
    while (query && (index = text.indexOf(query, index)) !== -1) {
      result.push([index, index + query.length]);
      index += Math.max(1, query.length);
    }
    return result;
  };

  async function evaluate(_tabId, payload) {
    calls.push(JSON.parse(JSON.stringify(payload)));
    if (payload.action === "probe") return { ok: true, page: { kind: "wiki" }, editor: {}, capabilities: { directSimpleEdit: true } };
    if (payload.action === "search") {
      const matches = [];
      for (const block of blocks) {
        const found = ranges(block.text, String(payload.query || ""));
        if (found.length) matches.push({ blockId: block.id, text: block.text, type: block.type, ranges: found });
      }
      const limit = Number(payload.limit) || 20;
      return {
        ok: true,
        matches: matches.slice(0, limit),
        totalOccurrences: matches.reduce((sum, match) => sum + match.ranges.length, 0),
        totalMatchingBlocks: matches.length,
        resultLimitReached: matches.length > limit,
        documentScanTruncated: false,
      };
    }
    if (payload.action === "read") return { ok: true, blocks: blocks.map((block) => ({ blockId: block.id, text: block.text, type: block.type })) };
    if (payload.action === "prepare_text") {
      const operation = payload.operation || {};
      const block = currentBlock(operation.blockId);
      if (!block) return { ok: false, code: "session_block_not_found" };
      let start = 0;
      let end = 0;
      let replacement = "";
      if (operation.op === "replace_text") {
        const found = ranges(block.text, String(operation.search || ""));
        if (!found.length) return { ok: false, code: "text_not_found" };
        replacement = String(operation.replacement || "");
        if (operation.occurrence === "all") {
          return {
            ok: true,
            multi: true,
            blockId: block.id,
            requestedBlockId: operation.blockId,
            before: block.text,
            ranges: found,
            replacement,
            expectedAfter: [...found].reverse().reduce((text, range) => text.slice(0, range[0]) + replacement + text.slice(range[1]), block.text),
            ignoredCharacterCount: 0,
          };
        }
        [start, end] = found[(Number(operation.occurrence) || 1) - 1] || [];
        if (start === undefined) return { ok: false, code: "occurrence_not_found" };
      } else if (operation.op === "insert_text") {
        start = end = Number(operation.offset);
        replacement = String(operation.text || "");
      } else if (operation.op === "delete_text") {
        start = Number(operation.start);
        end = Number(operation.end);
      } else if (operation.op === "set_text") {
        start = 0;
        end = block.text.length;
        replacement = String(operation.text || "");
      } else if (operation.op === "format_text") {
        start = Number(operation.start);
        end = Number(operation.end);
      }
      return {
        ok: true,
        blockId: block.id,
        requestedBlockId: operation.blockId,
        before: block.text,
        start,
        end,
        replacement,
        expectedAfter: block.text.slice(0, start) + replacement + block.text.slice(end),
        ignoredCharacterCount: 0,
      };
    }
    if (payload.action === "verify_block") {
      const block = currentBlock(payload.blockId);
      if (!block) return { ok: false, code: "session_block_not_found" };
      const oldId = block.id;
      const freshId = `session:f${++serial}`;
      block.id = freshId;
      aliases.set(oldId, freshId);
      return { ok: block.text === payload.expectedText, actual: block.text, expected: payload.expectedText, blockId: freshId, comparisonMode: "exact" };
    }
    if (payload.action === "format_selection") return { ok: true, applied: [] };
    if (payload.action === "verify_format") return { ok: true, checks: [], blockId: currentBlock(payload.operation.blockId)?.id || payload.operation.blockId };
    throw new Error(`Unknown fake page action: ${payload.action}`);
  }

  async function replace(_tabId, prepared) {
    writeCount += 1;
    const block = currentBlock(prepared.blockId);
    if (!block) throw new Error("Prepared block disappeared");
    block.text = block.text.slice(0, prepared.start) + String(prepared.replacement || "") + block.text.slice(prepared.end);
  }

  context.__simpleEditSmoke.setEvaluate(evaluate);
  context.__simpleEditSmoke.setReplace(replace);
  return { blocks, calls, getWriteCount: () => writeCount, handler: context.__simpleEditSmoke.toolHandlers.lark_session };
}

const tests = [];

{
  const harness = createHarness([{ text: "选择open-claude项目下的extension目录" }]);
  const result = await harness.handler({ tabId: 1, action: "patch", operations: [{ op: "replace_text", search: "选择open-claude项目下的extension目录", replacement: "选择 open-claude 项目下的 extension 目录" }] });
  if (!result.ok || result.applied[0]?.after !== "选择 open-claude 项目下的 extension 目录" || result.callerRereadRequired !== false) {
    throw new Error(`Direct unique replace failed: ${JSON.stringify(result)}`);
  }
  tests.push("direct_unique_replace");
}

{
  const harness = createHarness([{ text: "AlphaBeta" }]);
  const result = await harness.handler({ tabId: 1, action: "patch", operations: [{ op: "insert_text", anchorText: "Alpha", position: "after", text: " " }] });
  if (!result.ok || harness.blocks[0].text !== "Alpha Beta") throw new Error(`Anchor insert failed: ${JSON.stringify(result)}`);
  tests.push("anchor_insert");
}

{
  const harness = createHarness([{ id: "session:old", text: "one two" }]);
  const result = await harness.handler({ tabId: 1, action: "patch", operations: [
    { op: "replace_text", blockId: "session:old", search: "one", replacement: "ONE" },
    { op: "replace_text", blockId: "session:old", search: "two", replacement: "TWO" },
  ] });
  if (!result.ok || harness.blocks[0].text !== "ONE TWO") throw new Error(`Fresh block alias chain failed: ${JSON.stringify(result)}`);
  const preparedIds = harness.calls.filter((call) => call.action === "prepare_text").map((call) => call.operation.blockId);
  if (preparedIds[0] !== "session:old" || preparedIds[1] === "session:old") throw new Error(`Fresh alias was not reused: ${JSON.stringify(preparedIds)}`);
  tests.push("fresh_block_alias");
}

{
  const harness = createHarness([{ text: "same" }, { text: "same" }]);
  const result = await harness.handler({ tabId: 1, action: "patch", operations: [{ op: "replace_text", search: "same", replacement: "x" }] });
  if (result.ok || result.code !== "ambiguous_text_target" || harness.blocks.some((block) => block.text !== "same")) {
    throw new Error(`Ambiguity preflight failed: ${JSON.stringify(result)}`);
  }
  tests.push("ambiguous_preflight");
}

{
  const harness = createHarness([{ text: "repeat repeat repeat" }]);
  const result = await harness.handler({ tabId: 1, action: "patch", operations: [{ op: "replace_text", blockId: "session:b1", search: "repeat", replacement: "R", occurrence: "all" }] });
  if (!result.ok || harness.blocks[0].text !== "R R R" || result.applied[0]?.replacements !== 3) throw new Error(`replace_text occurrence=all failed: ${JSON.stringify(result)}`);
  tests.push("replace_text_all");
}

{
  const harness = createHarness([{ text: "A A A" }, { text: "A A" }]);
  const result = await harness.handler({ tabId: 1, action: "patch", operations: [{ op: "replace_all", search: "A", replacement: "X", limit: 2 }] });
  if (!result.ok || harness.blocks[0].text !== "X X A" || harness.blocks[1].text !== "A A" || result.applied[0]?.replacements !== 2) {
    throw new Error(`replace_all limit failed: ${JSON.stringify({ result, blocks: harness.blocks })}`);
  }
  tests.push("replace_all_limit");
}

{
  const harness = createHarness([{ text: "repeat repeat repeat" }]);
  const result = await harness.handler({ tabId: 1, action: "patch", operations: [{ op: "replace_text", search: "repeat", replacement: "R", occurrence: "all" }] });
  if (!result.ok || harness.blocks[0].text !== "R R R" || result.applied[0]?.replacements !== 3) {
    throw new Error(`Unique-block occurrence=all direct resolution failed: ${JSON.stringify(result)}`);
  }
  tests.push("direct_replace_all_unique_block");
}

{
  const harness = createHarness([{ text: "repeat repeat" }, { text: "repeat" }]);
  const result = await harness.handler({ tabId: 1, action: "patch", operations: [{ op: "replace_text", search: "repeat", replacement: "R", occurrence: "all" }] });
  if (result.ok || result.code !== "ambiguous_text_target" || harness.blocks[0].text !== "repeat repeat" || harness.blocks[1].text !== "repeat") {
    throw new Error(`Multi-block occurrence=all ambiguity guard failed: ${JSON.stringify(result)}`);
  }
  tests.push("direct_replace_all_multiblock_guard");
}

{
  const harness = createHarness([{ text: "same" }]);
  const result = await harness.handler({ tabId: 1, action: "patch", operations: [{ op: "replace_text", search: "same", replacement: "same" }] });
  if (!result.ok || result.applied[0]?.noOp !== true || harness.getWriteCount() !== 0 || result.applied[0]?.verification?.mode !== "adapter_no_op") {
    throw new Error(`No-op mutation was not short-circuited: ${JSON.stringify(result)}`);
  }
  tests.push("no_op_short_circuit");
}

{
  const harness = createHarness([{ text: "Alpha" }]);
  const result = await harness.handler({ tabId: 1, action: "patch", operations: [{ op: "insert_text", text: "X" }] });
  if (result.ok || result.code !== "session_invalid_operation_shape" || result.noWriteAttempted !== true || harness.getWriteCount() !== 0) {
    throw new Error(`Invalid operation shape was not rejected before write: ${JSON.stringify(result)}`);
  }
  tests.push("invalid_shape_preflight");
}

console.log(JSON.stringify({ ok: true, tests: tests.length, results: tests }));
