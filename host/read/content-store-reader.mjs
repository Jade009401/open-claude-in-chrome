// Serves document and section reads directly from the persisted content
// store — zero page interaction. The full text never leaves the host in one
// piece: every function returns at most the requested slice.

// Invisible/zero-width characters (U+200B/C/D, U+FEFF) that Lark sprinkles into
// blocks: they survive String.trim(), so a "blank" block reads as non-empty and
// a re-scraped block fails to dedupe unless they are stripped explicitly.
function stripInvisibles(text) {
  return String(text || '').replace(/[​‌‍﻿]/g, '');
}
function normalizeKey(text) {
  return stripInvisibles(text).replace(/\s+/g, ' ').trim();
}

// Mirrors the kernel's extractLeadingNumber shapes: "25. 标题", "25、", "25）",
// "(25)", "（25）", "第25条".
function leadingNumber(text) {
  const normalized = normalizeKey(text);
  const match = normalized.match(/^(?:[（(]\s*(\d{1,5})\s*[)）]|(\d{1,5})\s*[)）]|(?:第\s*)?(\d{1,5})(?:\s*条)?(?:[.、:：\s-]+|$))/);
  return match ? Number(match[1] ?? match[2] ?? match[3]) : null;
}

// Cleans the raw block stream before any read: drops only invisible/zero-width-
// only blocks (safe, lossless). No text-based dedup here — duplicate collapse is
// done at collection time by structural identity (same on-screen position), which
// cannot merge legitimate repeats (e.g. equal table-cell values on different
// rows). Text-based dedup would risk exactly that, so the read path stays no-loss.
function textBlocks(blocks = []) {
  const rows = [];
  for (const block of blocks) {
    const text = stripInvisibles(block?.text).trim();
    if (!text) continue;
    rows.push({ type: String(block?.type || 'paragraph'), text });
  }
  return rows;
}

// Whole-document summary source: every stored block, joined in stream order,
// capped at maxChars with an explicit truncation flag.
function summaryFromBlocks(blocks, options = {}) {
  const maxChars = Math.max(1000, Math.min(250000, Number(options.maxChars || 120000)));
  const rows = textBlocks(blocks);
  if (!rows.length) return null;
  const lines = [];
  let usedChars = 0;
  let truncated = false;
  let sectionCount = 0;
  for (const row of rows) {
    if (leadingNumber(row.text) !== null) sectionCount += 1;
    if (usedChars + row.text.length + 1 > maxChars) { truncated = true; break; }
    lines.push(row.text);
    usedChars += row.text.length + 1;
  }
  return {
    text: lines.join('\n'),
    blockCount: lines.length,
    totalBlockCount: rows.length,
    numberedSectionCount: sectionCount,
    truncated,
  };
}

// Single numbered-section read: from the first block whose leading number
// equals `ordinal` up to (excluding) the next block with a DIFFERENT leading
// number. Sub-blocks without numbers belong to the current section.
function sectionFromBlocks(blocks, ordinal, options = {}) {
  const maxChars = Math.max(500, Math.min(250000, Number(options.maxChars || 60000)));
  const target = Number(ordinal);
  if (!Number.isFinite(target)) return null;
  const rows = textBlocks(blocks);
  const startIndex = rows.findIndex((row) => leadingNumber(row.text) === target);
  if (startIndex < 0) return null;
  const lines = [];
  let usedChars = 0;
  let truncated = false;
  for (let index = startIndex; index < rows.length; index += 1) {
    const number = leadingNumber(rows[index].text);
    if (index > startIndex && number !== null && number !== target) break;
    if (usedChars + rows[index].text.length + 1 > maxChars) { truncated = true; break; }
    lines.push(rows[index].text);
    usedChars += rows[index].text.length + 1;
  }
  if (!lines.length) return null;
  return { text: lines.join('\n'), blockCount: lines.length, truncated };
}

export { leadingNumber, summaryFromBlocks, sectionFromBlocks };
