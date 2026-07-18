function normalize(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function parseOrdinal(query) {
  const text = normalize(query);
  const match = text.match(/(?:^|\s)(?:第\s*)?(\d{1,5})(?:\s*条|[.、:：)）\s-]|$)/)
    || text.match(/^\s*(\d{1,5})\s*$/);
  return match ? Number(match[1]) : null;
}

function ngrams(text, n = 2) {
  const value = normalize(text).replace(/\s/g, '');
  const set = new Set();
  if (!value) return set;
  if (value.length <= n) { set.add(value); return set; }
  for (let i = 0; i <= value.length - n; i += 1) set.add(value.slice(i, i + n));
  return set;
}

function overlapScore(left, right) {
  if (!left.size || !right.size) return 0;
  let common = 0;
  for (const item of left) if (right.has(item)) common += 1;
  return common / Math.max(left.size, right.size);
}

function anchorScore(anchor, query, options = {}) {
  const q = normalize(query);
  if (!q) return 0;
  const label = normalize(anchor.label);
  const locator = normalize(anchor.locator);
  const id = normalize(anchor.id);
  let score = 0;
  if (id === q || locator === q) score += 10000;
  const requestedOrdinal = parseOrdinal(q);
  if (requestedOrdinal !== null && Number(anchor.ordinal) === requestedOrdinal) score += 5000;
  if (label === q) score += 1800;
  else if (label.startsWith(q)) score += 1100;
  else if (label.includes(q)) score += 700;
  const keywords = normalize((anchor.searchText || []).join(' '));
  if (keywords.includes(q)) score += 420;
  score += overlapScore(ngrams(q, 2), ngrams(`${label} ${keywords}`, 2)) * 320;
  score += overlapScore(ngrams(q, 3), ngrams(`${label} ${keywords}`, 3)) * 220;
  if (options.types?.length && options.types.includes(anchor.kind)) score += 100;
  return score;
}

function locateInMap(map, query, options = {}) {
  const types = Array.isArray(options.types) ? options.types : [];
  const candidates = types.length ? map.anchors.filter((anchor) => types.includes(anchor.kind)) : map.anchors;
  const limit = Math.max(1, Math.min(5, Number(options.limit || 5)));
  const ranked = candidates
    .map((anchor) => ({ anchor, score: anchorScore(anchor, query, { types }) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || Number(a.anchor.order || 0) - Number(b.anchor.order || 0))
    .slice(0, limit);
  return {
    ok: true,
    found: ranked.length > 0,
    mapHandle: map.mapHandle,
    pageKey: map.pageKey,
    query: String(query || ''),
    coverage: 'anchors_only',
    matches: ranked.map(({ anchor, score }) => ({
      id: anchor.id,
      locator: anchor.locator,
      kind: anchor.kind,
      label: anchor.label,
      ordinal: anchor.ordinal ?? null,
      parentId: anchor.parentId || null,
      adapter: anchor.adapter,
      score: Math.round(score * 1000) / 1000,
      confidence: anchor.confidence,
      flags: anchor.flags || {},
    })),
  };
}

function resolveAnchor(map, target) {
  const value = normalize(typeof target === 'string' ? target : target?.id || target?.locator || '');
  if (!value) return null;
  return map.anchors.find((anchor) => normalize(anchor.id) === value || normalize(anchor.locator) === value) || null;
}

export { normalize, parseOrdinal, ngrams, locateInMap, resolveAnchor };
