import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const INDEX_VERSION = 2;
const DEFAULT_RETENTION_DAYS = 30;

function nowIso(nowMs = Date.now()) {
  return new Date(nowMs).toISOString();
}

function normalizeText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim();
}

function safeFileName(value) {
  const normalized = normalizeText(value) || 'Untitled';
  return normalized
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/g, '')
    .slice(0, 120) || 'Untitled';
}

function shortHash(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 8);
}

function tokenize(value) {
  const text = normalizeText(value).toLowerCase();
  const tokens = new Set();

  for (const match of text.matchAll(/[a-z0-9][a-z0-9._:/+-]*/g)) {
    if (match[0].length >= 2) tokens.add(match[0]);
  }

  const cjkRuns = text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu) || [];
  for (const run of cjkRuns) {
    if (run.length === 1) tokens.add(run);
    for (let index = 0; index < run.length - 1; index += 1) tokens.add(run.slice(index, index + 2));
    for (let index = 0; index < run.length - 2; index += 1) tokens.add(run.slice(index, index + 3));
  }

  return [...tokens];
}

function compactBlock(block, sections) {
  const ordinal = Number(block?.ordinal ?? -1);
  let section = null;
  for (const candidate of sections || []) {
    if (ordinal < Number(candidate.startOrdinal) || ordinal > Number(candidate.endOrdinal)) continue;
    if (!section || Number(candidate.level || 0) >= Number(section.level || 0)) section = candidate;
  }
  return {
    blockId: block?.blockId || null,
    sourceId: block?.sourceId || null,
    ordinal,
    type: block?.type || 'paragraph',
    text: normalizeText(block?.text || ''),
    virtualTop: Number.isFinite(Number(block?.virtualTop)) ? Number(block.virtualTop) : null,
    sectionId: section?.id || null,
    sectionTitle: section?.title || null,
    sectionPath: Array.isArray(section?.path) ? section.path : (section?.title ? [section.title] : []),
  };
}


function buildPositionAnchors(entries, scan) {
  const indexedMaxTop = Math.max(0, Number(scan?.target?.maxScrollTop || 0));
  const candidates = entries.filter((entry) => Number.isFinite(entry.virtualTop));
  if (!candidates.length) return [];
  const stride = Math.max(1, Math.floor(candidates.length / 80));
  const selected = [];
  for (let index = 0; index < candidates.length; index += stride) selected.push(candidates[index]);
  if (selected.at(-1) !== candidates.at(-1)) selected.push(candidates.at(-1));
  return selected.map((entry) => ({
    ordinal: entry.ordinal,
    sourceId: entry.sourceId || null,
    text: entry.text.slice(0, 160),
    virtualTop: Math.round(entry.virtualTop),
    scrollTop: Math.max(0, Math.round(entry.virtualTop)),
    relativePosition: indexedMaxTop > 0 ? Number((entry.virtualTop / indexedMaxTop).toFixed(6)) : null,
  }));
}

function bestLocateEntry(entries, query) {
  const normalized = normalizeText(query).toLowerCase();
  if (!normalized) return null;
  const exact = entries.find((entry) => entry.text.toLowerCase() === normalized);
  if (exact) return exact;
  const contains = entries.filter((entry) => entry.text.toLowerCase().includes(normalized));
  if (contains.length) return contains.sort((a, b) => a.text.length - b.text.length || a.ordinal - b.ordinal)[0];
  const tokens = tokenize(normalized);
  return entries
    .map((entry) => ({ entry, score: scoreEntry(entry, normalized, tokens) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.entry.ordinal - b.entry.ordinal)[0]?.entry || null;
}

function buildPostings(entries) {
  const postings = Object.create(null);
  entries.forEach((entry, index) => {
    for (const token of tokenize(entry.text)) {
      if (!postings[token]) postings[token] = [];
      postings[token].push(index);
    }
  });
  return postings;
}

function scoreEntry(entry, question, tokens) {
  const text = entry.text.toLowerCase();
  const normalizedQuestion = normalizeText(question).toLowerCase();
  let score = 0;
  if (normalizedQuestion && text.includes(normalizedQuestion)) score += 120;
  for (const token of tokens) {
    if (text.includes(token)) score += token.length >= 3 ? 12 : 6;
  }
  if (entry.sectionTitle && normalizedQuestion.includes(entry.sectionTitle.toLowerCase())) score += 20;
  if (/heading/i.test(entry.type)) score += 2;
  score -= Math.min(20, entry.text.length / 1000);
  return score;
}

function contextFor(entries, index, before, after, maxChars) {
  const start = Math.max(0, index - before);
  const end = Math.min(entries.length - 1, index + after);
  const result = [];
  let chars = 0;
  for (let cursor = start; cursor <= end; cursor += 1) {
    const entry = entries[cursor];
    const remaining = maxChars - chars;
    if (remaining <= 0) break;
    const text = entry.text.length > remaining ? `${entry.text.slice(0, Math.max(0, remaining - 1))}…` : entry.text;
    result.push({ ...entry, text });
    chars += text.length;
  }
  return result;
}

export class LarkIndexManager {
  constructor(options = {}) {
    this.rootDir = options.rootDir || path.join(os.homedir(), 'Library', 'Application Support', 'ClaudeSidebarHost', 'indexes');
    this.retentionDays = Number(options.retentionDays || DEFAULT_RETENTION_DAYS);
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    fs.mkdirSync(this.rootDir, { recursive: true });
  }

  indexPathFor(documentName, documentUrl) {
    const base = safeFileName(documentName);
    const preferred = path.join(this.rootDir, `${base}.json`);
    if (!fs.existsSync(preferred)) return preferred;
    try {
      const current = JSON.parse(fs.readFileSync(preferred, 'utf8'));
      if (String(current.documentUrl || '') === String(documentUrl || '')) return preferred;
    } catch {}
    return path.join(this.rootDir, `${base}__${shortHash(documentUrl)}.json`);
  }

  writeIndex(input) {
    const indexedAt = nowIso(this.now());
    const sections = Array.isArray(input.sections) ? input.sections : [];
    const entries = (Array.isArray(input.blocks) ? input.blocks : [])
      .map((block) => compactBlock(block, sections))
      .filter((entry) => entry.ordinal >= 0 && entry.text);
    const index = {
      indexVersion: INDEX_VERSION,
      documentName: normalizeText(input.documentName) || 'Untitled',
      documentUrl: String(input.documentUrl || ''),
      documentType: input.documentType || 'rich_doc',
      indexedAt,
      lastOpenedAt: indexedAt,
      blockCount: Number(input.blockCount || entries.length),
      indexedBlockCount: entries.length,
      sectionCount: sections.length,
      scan: input.scan || null,
      sections,
      entries,
      postings: buildPostings(entries),
      positionMetrics: {
        clientHeight: Number(input.scan?.target?.clientHeight || 0) || null,
        scrollHeight: Number(input.scan?.target?.scrollHeight || 0) || null,
        maxScrollTop: Number(input.scan?.target?.maxScrollTop || 0) || null,
      },
      positionAnchors: buildPositionAnchors(entries, input.scan),
    };
    const target = this.indexPathFor(index.documentName, index.documentUrl);
    const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(index));
    fs.renameSync(temp, target);
    return { indexPath: target, index };
  }

  readIndex(documentName, documentUrl, options = {}) {
    const target = this.indexPathFor(documentName, documentUrl);
    if (!fs.existsSync(target)) return null;
    const index = JSON.parse(fs.readFileSync(target, 'utf8'));
    if (options.touch !== false) {
      index.lastOpenedAt = nowIso(this.now());
      const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(index));
      fs.renameSync(temp, target);
    }
    return { indexPath: target, index };
  }

  readIndexPath(indexPath, options = {}) {
    if (!indexPath || !fs.existsSync(indexPath)) return null;
    const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    if (options.touch !== false) {
      index.lastOpenedAt = nowIso(this.now());
      const temp = `${indexPath}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(index));
      fs.renameSync(temp, indexPath);
    }
    return { indexPath, index };
  }


  readIndexByUrl(documentUrl, options = {}) {
    const targetUrl = String(documentUrl || '');
    for (const name of fs.readdirSync(this.rootDir)) {
      if (!name.endsWith('.json')) continue;
      const filePath = path.join(this.rootDir, name);
      try {
        const index = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (String(index.documentUrl || '') !== targetUrl) continue;
        return this.readIndexPath(filePath, options);
      } catch {}
    }
    return null;
  }

  status(documentName, documentUrl) {
    const loaded = this.readIndex(documentName, documentUrl, { touch: true });
    if (!loaded) {
      return {
        ok: true,
        exists: false,
        documentName: normalizeText(documentName) || 'Untitled',
        documentUrl: String(documentUrl || ''),
      };
    }
    return {
      ok: true,
      exists: true,
      indexPath: loaded.indexPath,
      documentName: loaded.index.documentName,
      documentUrl: loaded.index.documentUrl,
      indexedAt: loaded.index.indexedAt,
      lastOpenedAt: loaded.index.lastOpenedAt,
      blockCount: loaded.index.blockCount,
      indexedBlockCount: loaded.index.indexedBlockCount,
      sectionCount: loaded.index.sectionCount,
      documentType: loaded.index.documentType,
    };
  }

  query(indexOrPath, question, options = {}) {
    const loaded = typeof indexOrPath === 'string'
      ? this.readIndexPath(indexOrPath, { touch: true })
      : { indexPath: null, index: indexOrPath };
    if (!loaded?.index) return { ok: false, code: 'index_not_found' };

    const index = loaded.index;
    const entries = Array.isArray(index.entries) ? index.entries : [];
    const tokens = tokenize(question);
    const candidateIndexes = new Set();
    for (const token of tokens) {
      for (const entryIndex of index.postings?.[token] || []) candidateIndexes.add(entryIndex);
    }
    if (candidateIndexes.size === 0) entries.forEach((_, entryIndex) => candidateIndexes.add(entryIndex));

    const ranked = [...candidateIndexes]
      .map((entryIndex) => ({ entryIndex, score: scoreEntry(entries[entryIndex], question, tokens) }))
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score || left.entryIndex - right.entryIndex);

    const limit = Math.max(1, Math.min(20, Number(options.limit || 8)));
    const before = Math.max(0, Math.min(5, Number(options.contextBefore ?? 1)));
    const after = Math.max(0, Math.min(5, Number(options.contextAfter ?? 2)));
    const maxContextChars = Math.max(500, Math.min(30000, Number(options.maxContextChars || 12000)));
    const results = [];
    const seen = new Set();
    let chars = 0;

    for (const item of ranked) {
      if (results.length >= limit || chars >= maxContextChars) break;
      const entry = entries[item.entryIndex];
      const dedupeKey = `${entry.sectionId || ''}|${entry.text}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      const context = contextFor(entries, item.entryIndex, before, after, Math.max(300, maxContextChars - chars));
      const contextChars = context.reduce((sum, row) => sum + row.text.length, 0);
      chars += contextChars;
      results.push({
        score: Number(item.score.toFixed(3)),
        target: entry,
        context,
      });
    }

    return {
      ok: true,
      documentName: index.documentName,
      documentUrl: index.documentUrl,
      indexedAt: index.indexedAt,
      lastOpenedAt: index.lastOpenedAt,
      indexPath: loaded.indexPath,
      question: normalizeText(question),
      resultCount: results.length,
      results,
    };
  }

  locateHint(indexOrPath, query, options = {}) {
    const loaded = typeof indexOrPath === 'string'
      ? this.readIndexPath(indexOrPath, { touch: true })
      : { indexPath: null, index: indexOrPath };
    if (!loaded?.index) return { ok: false, code: 'index_not_found' };
    const index = loaded.index;
    const entries = Array.isArray(index.entries) ? index.entries : [];
    const target = bestLocateEntry(entries, query);
    if (!target) return { ok: true, found: false, query: normalizeText(query), indexedAt: index.indexedAt };
    const radius = Math.max(10, Math.min(250, Number(options.windowRadius || 80)));
    const start = Math.max(0, target.ordinal - radius);
    const end = Math.min(entries.length - 1, target.ordinal + radius);
    const indexedMaxTop = Number(index.positionMetrics?.maxScrollTop || index.positionMetrics?.scrollHeight || 0) || null;
    return {
      ok: true,
      found: true,
      indexPath: loaded.indexPath,
      indexedAt: index.indexedAt,
      targetHint: {
        ordinal: target.ordinal,
        sourceId: target.sourceId || null,
        text: target.text,
        virtualTop: Number.isFinite(target.virtualTop) ? target.virtualTop : null,
        relativePosition: indexedMaxTop && Number.isFinite(target.virtualTop)
          ? Number((target.virtualTop / indexedMaxTop).toFixed(6))
          : (entries.length > 1 ? Number((target.ordinal / (entries.length - 1)).toFixed(6)) : 0),
        totalBlocks: entries.length,
        indexedMaxTop,
        indexedScrollHeight: Number(index.positionMetrics?.scrollHeight || 0) || null,
        indexedViewport: Number(index.positionMetrics?.clientHeight || 0) || null,
        anchors: Array.isArray(index.positionAnchors) ? index.positionAnchors : [],
        ordinalWindow: entries.slice(start, end + 1).map((entry) => ({
          ordinal: entry.ordinal,
          sourceId: entry.sourceId || null,
          text: entry.text.slice(0, 240),
          virtualTop: Number.isFinite(entry.virtualTop) ? entry.virtualTop : null,
        })),
      },
    };
  }

  cleanupExpired(options = {}) {
    const retentionDays = Number(options.retentionDays || this.retentionDays);
    const cutoffMs = this.now() - retentionDays * 24 * 60 * 60 * 1000;
    const deleted = [];
    const kept = [];
    for (const name of fs.readdirSync(this.rootDir)) {
      if (!name.endsWith('.json')) continue;
      const filePath = path.join(this.rootDir, name);
      try {
        const index = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const lastOpenedMs = Date.parse(index.lastOpenedAt || index.indexedAt || 0);
        if (Number.isFinite(lastOpenedMs) && lastOpenedMs < cutoffMs) {
          fs.unlinkSync(filePath);
          deleted.push(filePath);
        } else {
          kept.push(filePath);
        }
      } catch {
        const stat = fs.statSync(filePath);
        if (stat.mtimeMs < cutoffMs) {
          fs.unlinkSync(filePath);
          deleted.push(filePath);
        } else {
          kept.push(filePath);
        }
      }
    }
    return { ok: true, retentionDays, deletedCount: deleted.length, deleted, keptCount: kept.length };
  }
}

export const internals = Object.freeze({
  normalizeText,
  safeFileName,
  shortHash,
  tokenize,
  buildPostings,
  scoreEntry,
  buildPositionAnchors,
  bestLocateEntry,
});
