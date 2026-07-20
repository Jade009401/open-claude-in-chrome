function normalizeText(value) {
  return String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
}

function requirementStartPattern(number) {
  const n = String(Number(number));
  return new RegExp(`^(?:第\\s*${n}\\s*(?:条|项|点)|${n}\\s*[.．、:：)）]|[（(]\\s*${n}\\s*[)）])(?:\\s*|$)`, 'i');
}

function anyRequirementStart(text) {
  const value = normalizeText(text);
  let match = value.match(/^第\s*(\d{1,4})\s*(?:条|项|点)(?:\s*|$)/i);
  if (match) return Number(match[1]);
  match = value.match(/^(\d{1,4})\s*[.．、:：)）](?:\s*|$)/);
  if (match) return Number(match[1]);
  match = value.match(/^[（(]\s*(\d{1,4})\s*[)）](?:\s*|$)/);
  if (match) return Number(match[1]);
  return null;
}

function headingRank(type) {
  const match = String(type || '').match(/heading\s*(\d+)/i);
  return match ? Number(match[1]) : null;
}

function entryEvidence(entry) {
  return {
    ordinal: Number(entry.ordinal),
    blockId: entry.blockId || null,
    sourceId: entry.sourceId || null,
    type: entry.type || 'paragraph',
    text: normalizeText(entry.text),
    sectionId: entry.sectionId || null,
    sectionTitle: entry.sectionTitle || null,
    sectionPath: Array.isArray(entry.sectionPath) ? entry.sectionPath : [],
    virtualTop: Number.isFinite(Number(entry.virtualTop)) ? Number(entry.virtualTop) : null,
  };
}

export function findNumberedRequirement(index, requirementNumber, options = {}) {
  const number = Number(requirementNumber);
  if (!Number.isInteger(number) || number < 1) {
    return { ok: false, code: 'invalid_requirement_number', requirementNumber };
  }
  const entries = Array.isArray(index?.entries) ? index.entries : [];
  const wanted = requirementStartPattern(number);
  const candidates = [];
  entries.forEach((entry, entryIndex) => {
    const text = normalizeText(entry.text);
    if (!wanted.test(text)) return;
    const rank = headingRank(entry.type);
    let score = 100;
    if (rank !== null) score += 80 - Math.min(60, rank * 10);
    if (/^第\s*\d+\s*(?:条|项|点)/i.test(text)) score += 25;
    if (entry.sectionTitle && wanted.test(normalizeText(entry.sectionTitle))) score += 20;
    score -= Math.min(30, text.length / 20);
    candidates.push({ entryIndex, entry, score });
  });
  if (!candidates.length) {
    return {
      ok: true,
      found: false,
      code: 'requirement_number_not_found',
      requirementNumber: number,
      documentName: index?.documentName || null,
      documentUrl: index?.documentUrl || null,
      indexedAt: index?.indexedAt || null,
      sourceComplete: index?.scan?.complete === true,
    };
  }
  candidates.sort((a, b) => b.score - a.score || a.entryIndex - b.entryIndex);
  const selected = candidates[0];
  const startRank = headingRank(selected.entry.type);
  const maxBlocks = Math.max(2, Math.min(200, Number(options.maxBlocks || 80)));
  const maxChars = Math.max(1000, Math.min(100000, Number(options.maxChars || 30000)));
  const blocks = [];
  let chars = 0;
  let stopReason = 'document_end';
  for (let cursor = selected.entryIndex; cursor < entries.length; cursor += 1) {
    const entry = entries[cursor];
    const text = normalizeText(entry.text);
    if (cursor > selected.entryIndex) {
      const nextNumber = anyRequirementStart(text);
      const nextRank = headingRank(entry.type);
      const parenthesizedSubitem = /^[（(]\s*\d+\s*[)）]/.test(text);
      const isNextTopLevel = !parenthesizedSubitem && nextNumber !== null && nextNumber !== number && (
        startRank === null || nextRank === null || nextRank <= startRank || /^(?:第\s*\d+|\d+\s*[.．、:：])/.test(text)
      );
      if (isNextTopLevel) { stopReason = 'next_requirement'; break; }
      if (selected.entry.sectionId && entry.sectionId && entry.sectionId !== selected.entry.sectionId && nextRank !== null && startRank !== null && nextRank <= startRank) {
        stopReason = 'section_boundary';
        break;
      }
    }
    if (!text) continue;
    if (blocks.length >= maxBlocks) { stopReason = 'max_blocks'; break; }
    if (chars + text.length > maxChars) { stopReason = 'max_chars'; break; }
    blocks.push(entryEvidence(entry));
    chars += text.length;
  }
  return {
    ok: true,
    found: true,
    requirementNumber: number,
    title: normalizeText(selected.entry.text),
    documentName: index?.documentName || null,
    documentUrl: index?.documentUrl || null,
    indexedAt: index?.indexedAt || null,
    sourceComplete: index?.scan?.complete === true,
    match: entryEvidence(selected.entry),
    blocks,
    blockCount: blocks.length,
    charCount: chars,
    stopReason,
    evidenceContract: 'Numbered heading matched at the start of a block; content continues until the next top-level numbered requirement or section boundary.',
  };
}


export function analyzeDocumentCoverage(index, options = {}) {
  const entries = Array.isArray(index?.entries) ? index.entries : [];
  const sections = Array.isArray(index?.sections) ? index.sections : [];
  const bodyEntries = entries.filter((entry) => {
    const text = normalizeText(entry?.text);
    return Boolean(text) && !/^heading\s*[1-6]$/i.test(String(entry?.type || ''));
  });
  const headingEntries = entries.filter((entry) => /^heading\s*[1-6]$/i.test(String(entry?.type || '')));
  const bodyCharCount = bodyEntries.reduce((sum, entry) => sum + normalizeText(entry.text).length, 0);
  const leafSections = sections.filter((section) => !Array.isArray(section?.childIds) || section.childIds.length === 0);
  const coveredLeafSections = leafSections.filter((section) => bodyEntries.some((entry) => {
    const ordinal = Number(entry.ordinal);
    return ordinal > Number(section.startOrdinal) && ordinal <= Number(section.endOrdinal);
  }));
  const leafSectionCoverage = leafSections.length ? coveredLeafSections.length / leafSections.length : null;
  const sectionCount = sections.length;
  const requiredBodyBlocks = sectionCount >= 10
    ? Math.max(8, Math.min(80, Math.ceil(sectionCount * 0.4)))
    : Math.max(1, Math.min(4, sectionCount || 1));
  const requiredBodyChars = sectionCount >= 10
    ? Math.max(2000, Math.min(20000, sectionCount * 140))
    : 60;
  const requiredLeafSectionCoverage = leafSections.length >= 8 ? 0.5 : leafSections.length ? 0.25 : null;
  const scanBody = index?.scan?.body || null;
  const sourceComplete = index?.scan?.complete === true;
  const scannerBodyComplete = scanBody ? scanBody.evidenceComplete === true : true;
  const blockCoverageComplete = bodyEntries.length >= requiredBodyBlocks;
  const charCoverageComplete = bodyCharCount >= requiredBodyChars;
  const sectionCoverageComplete = requiredLeafSectionCoverage === null
    || leafSectionCoverage >= requiredLeafSectionCoverage;
  const complete = sourceComplete && scannerBodyComplete && blockCoverageComplete
    && charCoverageComplete && sectionCoverageComplete;
  return {
    complete,
    sourceComplete,
    scannerBodyComplete,
    indexedBlockCount: entries.length,
    headingBlockCount: headingEntries.length,
    bodyBlockCount: bodyEntries.length,
    bodyCharCount,
    sectionCount,
    leafSectionCount: leafSections.length,
    coveredLeafSectionCount: coveredLeafSections.length,
    leafSectionCoverage: leafSectionCoverage === null ? null : Number(leafSectionCoverage.toFixed(4)),
    requiredBodyBlocks,
    requiredBodyChars,
    requiredLeafSectionCoverage,
    reasons: [
      !sourceComplete ? 'source_scan_incomplete' : null,
      !scannerBodyComplete ? 'scanner_body_incomplete' : null,
      !blockCoverageComplete ? 'body_block_coverage_insufficient' : null,
      !charCoverageComplete ? 'body_character_coverage_insufficient' : null,
      !sectionCoverageComplete ? 'leaf_section_coverage_insufficient' : null,
    ].filter(Boolean),
  };
}

export function buildDocumentSummaryContext(index, options = {}) {
  const entries = Array.isArray(index?.entries) ? index.entries : [];
  const sections = Array.isArray(index?.sections) ? index.sections : [];
  const coverage = analyzeDocumentCoverage(index, options);
  if (!coverage.complete) {
    return {
      ok: false,
      code: 'structured_body_incomplete',
      documentName: index?.documentName || null,
      documentUrl: index?.documentUrl || null,
      indexedAt: index?.indexedAt || null,
      coverage,
      structuredReadRequired: true,
      fallbackAllowed: false,
      message: 'The document outline or partial body was available, but complete body evidence was not indexed. Do not summarize from outline-only or partially rendered content.',
    };
  }
  const maxChars = Math.max(3000, Math.min(120000, Number(options.maxChars || 45000)));
  const maxOutline = Math.max(10, Math.min(300, Number(options.maxOutline || 100)));
  const maxEvidence = Math.max(20, Math.min(500, Number(options.maxEvidence || 160)));
  const outline = sections.slice(0, maxOutline).map((section) => ({
    id: section.id || null,
    title: normalizeText(section.title),
    level: Number(section.level || 0) || null,
    startOrdinal: Number(section.startOrdinal),
    endOrdinal: Number(section.endOrdinal),
    path: Array.isArray(section.path) ? section.path.map(normalizeText) : [],
  }));
  const selectedIndexes = new Set();
  entries.slice(0, 30).forEach((_, indexValue) => selectedIndexes.add(indexValue));
  entries.forEach((entry, indexValue) => {
    if (/heading/i.test(String(entry.type || '')) || anyRequirementStart(entry.text) !== null) selectedIndexes.add(indexValue);
  });
  for (const section of sections) {
    const start = entries.findIndex((entry) => Number(entry.ordinal) >= Number(section.startOrdinal));
    if (start >= 0) {
      selectedIndexes.add(start);
      if (start + 1 < entries.length) selectedIndexes.add(start + 1);
      if (start + 2 < entries.length) selectedIndexes.add(start + 2);
    }
  }
  const evidence = [];
  let chars = 0;
  for (const entryIndex of [...selectedIndexes].sort((a, b) => a - b)) {
    if (evidence.length >= maxEvidence) break;
    const entry = entries[entryIndex];
    const text = normalizeText(entry?.text);
    if (!text || chars + text.length > maxChars) continue;
    evidence.push(entryEvidence(entry));
    chars += text.length;
  }
  return {
    ok: true,
    documentName: index?.documentName || null,
    documentUrl: index?.documentUrl || null,
    documentType: index?.documentType || null,
    indexedAt: index?.indexedAt || null,
    sourceComplete: index?.scan?.complete === true,
    sourceBlockCount: Number(index?.blockCount || entries.length),
    coverage,
    indexedBlockCount: entries.length,
    sectionCount: sections.length,
    outline,
    evidence,
    evidenceCharCount: chars,
    evidenceContract: 'Use only the supplied indexed outline and evidence. Do not infer unseen sections or claim full coverage unless sourceComplete is true.',
  };
}

export const internals = Object.freeze({ normalizeText, requirementStartPattern, anyRequirementStart, headingRank });
