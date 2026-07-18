const NAVIGATION_MAP_SCHEMA_VERSION = 1;
const NAVIGATION_MAP_RUNTIME = 'pure-map-runtime-v1';

const ANCHOR_KINDS = new Set([
  'document', 'document_section', 'numbered_section', 'document_block',
  'application', 'region', 'form', 'control', 'dialog',
  'table', 'table_row', 'table_cell', 'sheet', 'sheet_cell',
  'image', 'attachment', 'collapse', 'virtual_region',
  'figma_canvas', 'figma_node', 'canvas_surface', 'canvas_node',
  'data_field',
]);

function isValidAnchor(anchor) {
  return Boolean(
    anchor && typeof anchor === 'object'
    && typeof anchor.id === 'string' && anchor.id
    && typeof anchor.kind === 'string' && anchor.kind
    && typeof anchor.locator === 'string' && anchor.locator
  );
}

function validateNavigationMap(map) {
  const errors = [];
  if (!map || typeof map !== 'object') errors.push('map_required');
  if (map?.schemaVersion !== NAVIGATION_MAP_SCHEMA_VERSION) errors.push('schema_version_invalid');
  if (map?.runtime !== NAVIGATION_MAP_RUNTIME) errors.push('runtime_invalid');
  if (!map?.pageKey) errors.push('page_key_missing');
  if (!map?.mapHandle) errors.push('map_handle_missing');
  if (map?.status !== 'ready') errors.push('map_not_ready');
  if (map?.mapCoverage?.status && !['complete', 'complete_with_warnings'].includes(map.mapCoverage.status)) errors.push('map_coverage_not_publishable');
  if (!Array.isArray(map?.anchors)) errors.push('anchors_missing');
  else if (map.anchors.length === 0) errors.push('anchors_empty');
  for (const [index, anchor] of (map?.anchors || []).entries()) {
    if (!isValidAnchor(anchor)) errors.push(`anchor_invalid:${index}`);
  }
  const ids = new Set();
  for (const anchor of map?.anchors || []) {
    if (ids.has(anchor.id)) errors.push(`anchor_id_duplicate:${anchor.id}`);
    ids.add(anchor.id);
  }
  return { ok: errors.length === 0, errors };
}

// Tiny numbered-section coverage summary for the model-visible browser_map
// result: max/count plus up-to-16 gaps. A tail loss (e.g. a real 25th item the
// map never captured) shows up as max=24; a middle loss shows up in gaps. The
// full per-stage kernelTrace stays local (persisted map + host logs).
function ordinalCoverageFor(map) {
  const traced = Array.isArray(map.kernelTrace?.numberedFinal) ? map.kernelTrace.numberedFinal : null;
  const source = traced && traced.length
    ? traced
    : (map.anchors || []).filter((anchor) => anchor.kind === 'numbered_section').map((anchor) => anchor.ordinal);
  const numbers = [...new Set(source.map(Number).filter((value) => Number.isFinite(value) && value >= 1))].sort((a, b) => a - b);
  if (!numbers.length) return null;
  const have = new Set(numbers);
  const gaps = [];
  for (let value = numbers[0]; value <= numbers.at(-1) && gaps.length < 16; value += 1) {
    if (!have.has(value)) gaps.push(value);
  }
  return { min: numbers[0], max: numbers.at(-1), count: numbers.length, gaps };
}

function compactMapStatus(map) {
  const counts = {};
  for (const anchor of map.anchors || []) counts[anchor.kind] = (counts[anchor.kind] || 0) + 1;
  return {
    ok: true,
    status: map.status,
    mapHandle: map.mapHandle,
    pageKey: map.pageKey,
    mapVersion: map.mapVersion,
    schemaVersion: map.schemaVersion,
    title: map.page?.title || '',
    url: map.page?.url || '',
    adapter: map.adapter,
    capabilities: map.capabilities,
    anchorCount: map.anchors?.length || 0,
    anchorTypeCounts: counts,
    ordinalCoverage: ordinalCoverageFor(map),
    revision: map.revision || { state: 'unknown' },
    kernel: map.kernel || null,
    createdAt: map.createdAt,
    updatedAt: map.updatedAt,
    mapCoverage: map.mapCoverage,
  };
}

export {
  NAVIGATION_MAP_SCHEMA_VERSION,
  NAVIGATION_MAP_RUNTIME,
  ANCHOR_KINDS,
  isValidAnchor,
  validateNavigationMap,
  compactMapStatus,
};
