import './lark-reader-core.js';

const core = globalThis.OpenClaudeLarkReaderCore;
if (!core) throw new Error('OpenClaudeLarkReaderCore failed to initialize');

export const {
  normalizeText,
  stableFingerprint,
  normalizeBlockType,
  normalizeBlocks,
  buildDocumentMap,
  summarizeDocumentMap,
  readSection,
  readRange,
  searchDocument,
  executeRead,
  buildAutomationSource,
  classifyDocumentType,
  createTextMatcher,
  rankLocateCandidates,
} = core;
