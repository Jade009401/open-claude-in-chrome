import './virtual-scroll-seek.js';
const engine = globalThis.OpenClaudeVirtualScrollSeek;
if (!engine) throw new Error('OpenClaudeVirtualScrollSeek failed to initialize');
export const { seek, estimateInitialTop, normalizeAnchors, interpolateOrdinalTop, ordinalRange } = engine;
