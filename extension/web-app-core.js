/* Generic structured Web app reader core shared by browser adapters and tests. */
((root) => {
  function normalizeText(value) {
    return String(value ?? '')
      .replace(/\u00a0/g, ' ')
      .replace(/[\t\r ]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function createMatcher(query, options = {}) {
    const normalized = normalizeText(query);
    const caseSensitive = options.caseSensitive === true;
    const mode = String(options.matchMode || 'contains').toLowerCase();
    if (!normalized) return () => true;
    if (mode === 'regex') {
      try {
        const regex = new RegExp(normalized, caseSensitive ? '' : 'i');
        return (value) => regex.test(normalizeText(value));
      } catch {
        return () => false;
      }
    }
    const needle = caseSensitive ? normalized : normalized.toLowerCase();
    return (value) => {
      const raw = normalizeText(value);
      const haystack = caseSensitive ? raw : raw.toLowerCase();
      return mode === 'exact' ? haystack === needle : haystack.includes(needle);
    };
  }

  const STOP_WORDS = new Set([
    'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'current', 'find', 'for', 'from', 'get', 'in', 'is', 'it', 'of', 'on', 'or', 'show', 'the', 'this', 'to', 'what', 'with',
    '一下', '当前', '怎么', '是什么', '查看', '查询', '查找', '显示', '找到', '请', '里面', '页面', '现在', '相关', '这个', '那个',
  ]);

  function tokenizeQuery(query, explicitTerms = []) {
    const text = normalizeText(query);
    const values = [];
    const push = (value) => {
      const normalized = normalizeText(value).replace(/^["'“”]+|["'“”]+$/g, '');
      if (!normalized) return;
      const lowered = normalized.toLowerCase();
      if (STOP_WORDS.has(lowered)) return;
      if (normalized.length === 1 && !/[0-9]/.test(normalized)) return;
      if (!values.some((item) => item.toLowerCase() === lowered)) values.push(normalized);
    };
    for (const term of explicitTerms || []) push(term);
    for (const match of text.matchAll(/["“]([^"”]{2,120})["”]/g)) push(match[1]);
    for (const token of text.match(/[\p{L}\p{N}_./:@-]+/gu) || []) push(token);
    if (text && text.length <= 120) push(text);
    return values.slice(0, 16);
  }

  function detectAppProfile(input = {}) {
    const combined = `${normalizeText(input.url)}\n${normalizeText(input.title)}\n${normalizeText(input.text)}`.toLowerCase();
    const rules = [
      { product: 'kubernetes_dashboard', family: 'infrastructure', regex: /kubernetes|k8s|workloads|daemonsets|statefulsets|\bpods?\b/ },
      { product: 'argocd', family: 'deployment', regex: /argocd|argo cd/ },
      { product: 'grafana', family: 'observability', regex: /grafana/ },
      { product: 'kibana', family: 'observability', regex: /kibana|elastic observability/ },
      { product: 'datadog', family: 'observability', regex: /datadog/ },
      { product: 'sentry', family: 'observability', regex: /sentry/ },
      { product: 'jenkins', family: 'ci_cd', regex: /jenkins/ },
      { product: 'github', family: 'source_control', regex: /github/ },
      { product: 'gitlab', family: 'source_control', regex: /gitlab/ },
      { product: 'aws_console', family: 'cloud_console', regex: /console\.aws\.amazon|aws management console/ },
      { product: 'gcp_console', family: 'cloud_console', regex: /console\.cloud\.google|google cloud console/ },
      { product: 'azure_portal', family: 'cloud_console', regex: /portal\.azure|microsoft azure/ },
    ];
    const matched = rules.find((rule) => rule.regex.test(combined));
    if (matched) return { ...matched, confidence: 0.95 };
    const adminSignals = (combined.match(/dashboard|console|admin|management|workspace|operations|monitoring|资源|管理|控制台/g) || []).length;
    return {
      product: 'generic_web_app',
      family: adminSignals > 0 ? 'admin_console' : 'generic_web_app',
      confidence: adminSignals > 0 ? 0.65 : 0.4,
    };
  }

  function detectAppType(input = {}) {
    return detectAppProfile(input).product;
  }

  function normalizeHeaders(headers = [], width = 0) {
    const result = headers.map((header, index) => normalizeText(header) || `column_${index + 1}`);
    while (result.length < width) result.push(`column_${result.length + 1}`);
    return result;
  }

  function buildStructuredRow(raw = {}) {
    const cells = Array.isArray(raw.cells) ? raw.cells.map(normalizeText) : [];
    const headers = normalizeHeaders(raw.headers || [], cells.length);
    const values = {};
    headers.forEach((header, index) => {
      const key = header || `column_${index + 1}`;
      if (!(key in values)) values[key] = cells[index] ?? '';
      else values[`${key}_${index + 1}`] = cells[index] ?? '';
    });
    const text = normalizeText(raw.text || cells.join(' | '));
    const links = (raw.links || []).map((link) => ({
      text: normalizeText(link?.text),
      href: String(link?.href || ''),
    })).filter((link) => link.text || link.href);
    const key = normalizeText(`${raw.key || raw.sourceId || ''}|${raw.rowIndex ?? ''}|${text}|${links.map((link) => link.href).join('|')}`);
    return {
      key,
      rowIndex: Number.isFinite(Number(raw.rowIndex)) ? Number(raw.rowIndex) : null,
      text,
      cells,
      headers,
      values,
      links,
      sourceId: raw.sourceId || null,
      surfaceIndex: Number.isFinite(Number(raw.surfaceIndex)) ? Number(raw.surfaceIndex) : null,
      surfaceType: raw.surfaceType || null,
    };
  }

  function scoreRow(row, query, options = {}) {
    const rowTextRaw = normalizeText(row?.text);
    const rowText = options.caseSensitive === true ? rowTextRaw : rowTextRaw.toLowerCase();
    const fullQueryRaw = normalizeText(query);
    const fullQuery = options.caseSensitive === true ? fullQueryRaw : fullQueryRaw.toLowerCase();
    const terms = tokenizeQuery(query, options.terms).map((term) => options.caseSensitive === true ? term : term.toLowerCase());
    const matchedTerms = terms.filter((term) => rowText.includes(term));
    const exactMatcher = createMatcher(query, options);
    const fullMatched = fullQueryRaw ? exactMatcher(rowTextRaw) : true;
    if (!fullMatched && matchedTerms.length === 0) return { score: -1, matchedTerms: [] };

    let score = fullMatched ? 25 : 0;
    if (fullQuery && rowText === fullQuery) score += 120;
    if (fullQuery && rowText.startsWith(fullQuery)) score += 35;
    score += matchedTerms.length * 18;
    for (const [field, value] of Object.entries(row?.values || {})) {
      const fieldText = options.caseSensitive === true ? normalizeText(field) : normalizeText(field).toLowerCase();
      const valueText = options.caseSensitive === true ? normalizeText(value) : normalizeText(value).toLowerCase();
      for (const term of terms) {
        if (valueText === term) score += 90;
        else if (valueText.includes(term)) score += 28;
        if (fieldText === term) score += 12;
      }
    }
    score -= Math.min(18, Math.max(0, rowTextRaw.length - Math.max(1, fullQueryRaw.length)) / 160);
    return { score, matchedTerms };
  }

  function rankRows(rows = [], query, options = {}) {
    return rows
      .map((row) => ({ row, ...scoreRow(row, query, options) }))
      .filter((item) => item.score >= 0)
      .sort((a, b) => b.score - a.score || (a.row.rowIndex ?? Number.MAX_SAFE_INTEGER) - (b.row.rowIndex ?? Number.MAX_SAFE_INTEGER))
      .map((item) => ({ ...item.row, matchedTerms: item.matchedTerms, matchScore: Math.round(item.score * 100) / 100 }));
  }

  function extractArtifactReferences(value) {
    const text = normalizeText(value);
    const containerImage = /(?:[a-z0-9.-]+(?::\d+)?\/)?(?:[a-z0-9._-]+\/)+[a-z0-9._-]+(?::[A-Za-z0-9._-]+|@sha256:[a-f0-9]{32,})/gi;
    const commitSha = /\b[a-f0-9]{7,40}\b/gi;
    const semanticVersion = /\bv?\d+\.\d+\.\d+(?:[-+][A-Za-z0-9._-]+)?\b/g;
    return {
      containerImages: [...new Set(text.match(containerImage) || [])],
      commitShas: [...new Set(text.match(commitSha) || [])],
      versions: [...new Set(text.match(semanticVersion) || [])],
    };
  }

  function extractImageReferences(value) {
    return extractArtifactReferences(value).containerImages;
  }

  function buildConfirmedFacts(input = {}) {
    const facts = [];
    const seen = new Set();
    const add = (fact) => {
      const field = normalizeText(fact.field);
      const value = normalizeText(fact.value);
      if (!field || !value) return;
      const key = `${field.toLowerCase()}|${value}|${fact.sourceType || ''}|${fact.sourceUrl || ''}`;
      if (seen.has(key)) return;
      seen.add(key);
      facts.push({ ...fact, field, value });
    };
    for (const row of input.rows || []) {
      for (const [field, value] of Object.entries(row.values || {})) {
        add({
          field,
          value,
          sourceType: 'table_row',
          sourceUrl: input.url || null,
          rowIndex: row.rowIndex,
          rowKey: row.key || null,
        });
      }
    }
    for (const pair of input.details || []) {
      add({
        field: pair.key,
        value: pair.value,
        sourceType: 'detail_field',
        sourceUrl: pair.sourceUrl || input.url || null,
        rowIndex: null,
        rowKey: null,
      });
    }
    return facts;
  }

  const FIELD_ALIAS_GROUPS = [
    ['name', '名称', 'resource name', '项目名', '应用名'],
    ['status', 'state', '状态', 'ready', 'health', '健康状态'],
    ['image', 'container image', '镜像', '镜像地址', 'image tag', '镜像tag'],
    ['namespace', '命名空间'],
    ['environment', 'env', '环境', '环境名称'],
    ['version', '版本', 'release'],
    ['branch', '分支', 'git branch'],
    ['commit', 'commit sha', 'sha', '提交', '提交哈希'],
    ['owner', '负责人', '维护人'],
    ['uid', 'user id', '用户id', '用户 id'],
    ['created at', 'creation time', '创建时间', '注册时间'],
    ['updated at', 'update time', '更新时间'],
  ];

  function canonicalField(value) {
    const normalized = normalizeText(value).toLowerCase().replace(/[\s_-]+/g, ' ');
    for (const group of FIELD_ALIAS_GROUPS) {
      if (group.some((alias) => normalized === alias || normalized.includes(alias) || alias.includes(normalized))) return group[0];
    }
    return normalized;
  }

  function matchRequestedFields(facts = [], requestedFields = []) {
    const fields = (requestedFields || []).map(normalizeText).filter(Boolean);
    if (!fields.length) return { requestedFields: [], matches: [], missingFields: [] };
    const matches = [];
    const missingFields = [];
    for (const requested of fields) {
      const requestedCanonical = canonicalField(requested);
      const found = facts.filter((fact) => {
        const field = normalizeText(fact.field);
        const fieldCanonical = canonicalField(field);
        const rawNeedle = requested.toLowerCase();
        const rawField = field.toLowerCase();
        return fieldCanonical === requestedCanonical || rawField.includes(rawNeedle) || rawNeedle.includes(rawField);
      });
      if (found.length) matches.push({ requestedField: requested, canonicalField: requestedCanonical, facts: found });
      else missingFields.push(requested);
    }
    return { requestedFields: fields, matches, missingFields };
  }

  const UNSAFE_DETAIL_LINK = /(?:^|[\/_?#=&-])(delete|remove|destroy|logout|signout|edit|new|create|execute|trigger|restart|rollback|approve|reject|cancel|terminate)(?:$|[\/_?#=&-])/i;

  function selectDetailLinks(rows = [], currentUrl, options = {}) {
    let origin = null;
    try { origin = new URL(currentUrl).origin; } catch {}
    if (!origin) return [];
    const maxLinks = Math.max(1, Math.min(5, Number(options.maxDetailLinks || 2)));
    const queryTerms = tokenizeQuery(options.query || '', options.terms).map((term) => term.toLowerCase());
    const candidates = [];
    const seen = new Set();
    for (const row of rows) {
      for (const link of row.links || []) {
        try {
          const url = new URL(link.href, currentUrl);
          if (!/^https?:$/.test(url.protocol) || url.origin !== origin) continue;
          const combined = `${url.pathname}${url.search}${url.hash}`;
          if (UNSAFE_DETAIL_LINK.test(combined)) continue;
          const key = url.href;
          if (seen.has(key)) continue;
          seen.add(key);
          const text = normalizeText(link.text);
          const haystack = `${text} ${combined}`.toLowerCase();
          let score = 10 + Number(row.matchScore || 0);
          for (const term of queryTerms) if (haystack.includes(term)) score += 20;
          if (text && row.text?.toLowerCase().includes(text.toLowerCase())) score += 8;
          candidates.push({ text, href: url.href, rowKey: row.key || null, score });
        } catch {}
      }
    }
    return candidates.sort((a, b) => b.score - a.score).slice(0, maxLinks);
  }


function compactSearchValue(value) {
  return normalizeText(value)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function primitiveMatchesQuery(value, query, options = {}) {
  const raw = normalizeText(value);
  if (!raw) return { matched: false, score: 0, matchedTerms: [] };
  const terms = tokenizeQuery(query, options.terms).filter((term) => normalizeText(term).length >= 2);
  const compactValue = compactSearchValue(raw);
  const compactQuery = compactSearchValue(query);
  const matchedTerms = [];
  let score = 0;
  for (const term of terms) {
    const compactTerm = compactSearchValue(term);
    if (!compactTerm) continue;
    if (compactValue === compactTerm) {
      score += 140;
      matchedTerms.push(term);
    } else if (compactValue.includes(compactTerm)) {
      score += Math.max(24, 70 - Math.min(40, compactValue.length - compactTerm.length));
      matchedTerms.push(term);
    }
  }
  if (compactQuery && compactValue === compactQuery) score += 180;
  else if (compactQuery && compactValue.includes(compactQuery)) score += 80;
  return { matched: score > 0, score, matchedTerms: [...new Set(matchedTerms)] };
}

function objectIdentity(value, path = '$') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const metadata = value.metadata && typeof value.metadata === 'object' ? value.metadata : null;
  const directName = normalizeText(value.name || value.title || value.serviceName || value.appName || value.resourceName || value.id || value.uid);
  const metadataName = normalizeText(metadata?.name);
  const namespace = normalizeText(metadata?.namespace || value.namespace);
  const kind = normalizeText(value.kind || value.type || value.resourceType);
  if (metadataName) {
    return {
      score: 260 + (kind ? 40 : 0) + (namespace ? 10 : 0),
      entityName: metadataName,
      entityKind: kind || null,
      namespace: namespace || null,
      entityPath: path,
      identitySource: 'metadata.name',
    };
  }
  if (directName) {
    return {
      score: 120 + (kind ? 20 : 0),
      entityName: directName,
      entityKind: kind || null,
      namespace: namespace || null,
      entityPath: path,
      identitySource: value.name ? 'name' : (value.title ? 'title' : (value.id ? 'id' : 'identity')),
    };
  }
  return null;
}

function flattenPrimitiveContext(value, options = {}) {
  const maxDepth = Math.max(1, Math.min(10, Number(options.maxDepth || 6)));
  const maxFields = Math.max(1, Math.min(300, Number(options.maxFields || 120)));
  const preferred = /(?:^|\.)(?:name|title|id|uid|kind|type|namespace|image|images|command|commands|args|arguments|entrypoint|version|branch|commit|sha|status|state|service|app|container|containers|metadata)$/i;
  const result = [];
  const stack = [{ value, path: '$', depth: 0 }];
  while (stack.length && result.length < maxFields) {
    const current = stack.pop();
    if (current.value === null || current.value === undefined) continue;
    if (typeof current.value !== 'object') {
      const text = normalizeText(current.value);
      if (text) result.push({ path: current.path, value: text, preferred: preferred.test(current.path) });
      continue;
    }
    if (current.depth >= maxDepth) continue;
    if (Array.isArray(current.value)) {
      for (let index = Math.min(current.value.length, 80) - 1; index >= 0; index -= 1) {
        stack.push({ value: current.value[index], path: `${current.path}[${index}]`, depth: current.depth + 1 });
      }
    } else {
      const entries = Object.entries(current.value).slice(0, 160);
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const [key, child] = entries[index];
        stack.push({ value: child, path: `${current.path}.${key}`, depth: current.depth + 1 });
      }
    }
  }
  return result.sort((a, b) => Number(b.preferred) - Number(a.preferred)).slice(0, maxFields);
}

function deepQueryJson(data, query, options = {}) {
  const maxNodes = Math.max(100, Math.min(250000, Number(options.maxNodes || 50000)));
  const maxDepth = Math.max(1, Math.min(40, Number(options.maxDepth || 20)));
  const maxMatches = Math.max(1, Math.min(500, Number(options.maxMatches || 80)));
  const stack = [{ value: data, path: '$', depth: 0, ancestors: [] }];
  const matches = [];
  const seen = new Set();
  let visitedNodes = 0;
  let truncated = false;

  while (stack.length && matches.length < maxMatches) {
    if (visitedNodes >= maxNodes) { truncated = true; break; }
    const current = stack.pop();
    visitedNodes += 1;
    const value = current.value;
    if (value === null || value === undefined) continue;

    if (typeof value !== 'object') {
      const match = primitiveMatchesQuery(value, query, options);
      if (!match.matched) continue;
      let identity = null;
      for (const ancestor of current.ancestors) {
        const candidate = objectIdentity(ancestor.value, ancestor.path);
        if (candidate && (!identity || candidate.score > identity.score)) identity = candidate;
      }
      const entityAncestor = identity
        ? current.ancestors.find((ancestor) => ancestor.path === identity.entityPath)
        : current.ancestors[0];
      const context = entityAncestor ? flattenPrimitiveContext(entityAncestor.value, options) : [];
      const key = `${identity?.entityPath || current.path}|${current.path}|${normalizeText(value)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      matches.push({
        score: match.score + Number(identity?.score || 0),
        matchedPath: current.path,
        matchedValue: normalizeText(value),
        matchedTerms: match.matchedTerms,
        entityName: identity?.entityName || null,
        entityKind: identity?.entityKind || null,
        namespace: identity?.namespace || null,
        entityPath: identity?.entityPath || null,
        identitySource: identity?.identitySource || null,
        context,
      });
      continue;
    }

    if (current.depth >= maxDepth) continue;
    const nextAncestors = [{ value, path: current.path }, ...current.ancestors].slice(0, 24);
    if (Array.isArray(value)) {
      const limit = Math.min(value.length, Math.max(1000, Number(options.maxArrayItems || 10000)));
      for (let index = limit - 1; index >= 0; index -= 1) {
        stack.push({ value: value[index], path: `${current.path}[${index}]`, depth: current.depth + 1, ancestors: nextAncestors });
      }
      if (value.length > limit) truncated = true;
    } else {
      const entries = Object.entries(value);
      const limit = Math.min(entries.length, 1000);
      for (let index = limit - 1; index >= 0; index -= 1) {
        const [key, child] = entries[index];
        stack.push({ value: child, path: `${current.path}.${key}`, depth: current.depth + 1, ancestors: nextAncestors });
      }
      if (entries.length > limit) truncated = true;
    }
  }

  return {
    matches: matches.sort((a, b) => b.score - a.score || String(a.matchedPath).localeCompare(String(b.matchedPath))),
    visitedNodes,
    truncated: truncated || stack.length > 0,
  };
}

function groupResolvedEntities(matches = [], options = {}) {
  const maxEntities = Math.max(1, Math.min(100, Number(options.maxEntities || 20)));
  const grouped = new Map();
  for (const match of matches || []) {
    const name = normalizeText(match.entityName);
    if (!name) continue;
    const key = `${match.sourceUrl || ''}|${match.entityPath || ''}|${name}|${match.namespace || ''}`;
    if (!grouped.has(key)) {
      grouped.set(key, {
        name,
        kind: normalizeText(match.entityKind) || null,
        namespace: normalizeText(match.namespace) || null,
        entityPath: match.entityPath || null,
        sourceUrl: match.sourceUrl || null,
        sourceType: match.sourceType || null,
        score: Number(match.score || 0),
        evidence: [],
        context: [],
      });
    }
    const entity = grouped.get(key);
    entity.score = Math.max(entity.score, Number(match.score || 0));
    const evidenceKey = `${match.matchedPath}|${match.matchedValue}`;
    if (!entity.evidence.some((item) => `${item.path}|${item.value}` === evidenceKey)) {
      entity.evidence.push({ path: match.matchedPath, value: match.matchedValue, matchedTerms: match.matchedTerms || [] });
    }
    for (const item of match.context || []) {
      const contextKey = `${item.path}|${item.value}`;
      if (!entity.context.some((existing) => `${existing.path}|${existing.value}` === contextKey)) entity.context.push(item);
    }
  }
  return [...grouped.values()]
    .map((entity) => ({ ...entity, evidence: entity.evidence.slice(0, 12), context: entity.context.slice(0, 120) }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, maxEntities);
}

const UNSAFE_DATA_URL = /(?:^|[\/_?#=&-])(delete|remove|destroy|logout|signout|edit|new|create|execute|trigger|restart|rollback|approve|reject|cancel|terminate|mutate|write|update)(?:$|[\/_?#=&-])/i;
const STATIC_DATA_EXT = /\.(?:js|mjs|css|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|map|mp4|webm|pdf|zip|gz)(?:$|[?#])/i;

function rankDataEndpoints(entries = [], currentUrl, query, options = {}) {
  let base;
  try { base = new URL(currentUrl); } catch { return []; }
  const terms = tokenizeQuery(query, options.terms).map(compactSearchValue).filter(Boolean);
  const seen = new Set();
  const candidates = [];
  for (const entry of entries || []) {
    const rawUrl = typeof entry === 'string' ? entry : (entry?.url || entry?.name || '');
    if (!rawUrl) continue;
    try {
      const url = new URL(rawUrl, currentUrl);
      if (!/^https?:$/.test(url.protocol) || url.origin !== base.origin) continue;
      const path = `${url.pathname}${url.search}`;
      if (UNSAFE_DATA_URL.test(path) || STATIC_DATA_EXT.test(path)) continue;
      if (seen.has(url.href)) continue;
      seen.add(url.href);
      const initiatorType = String(entry?.initiatorType || entry?.type || '').toLowerCase();
      let score = 0;
      if (/fetch|xmlhttprequest|xhr/.test(initiatorType)) score += 100;
      if (/api|graphql|query|list|search|data|resource|workload|deployment|service|job|build|report/i.test(path)) score += 40;
      if (/json/i.test(String(entry?.contentType || entry?.mimeType || ''))) score += 60;
      const compactUrl = compactSearchValue(path);
      for (const term of terms) if (compactUrl.includes(term)) score += 35;
      if (url.pathname === base.pathname) score -= 30;
      candidates.push({ url: url.href, initiatorType: initiatorType || null, score });
    } catch {}
  }
  return candidates.sort((a, b) => b.score - a.score).slice(0, Math.max(1, Math.min(20, Number(options.maxDataSources || 8))));
}

  root.OpenClaudeWebAppCore = Object.freeze({
    normalizeText,
    createMatcher,
    tokenizeQuery,
    detectAppProfile,
    detectAppType,
    normalizeHeaders,
    buildStructuredRow,
    rankRows,
    extractArtifactReferences,
    extractImageReferences,
    buildConfirmedFacts,
    canonicalField,
    matchRequestedFields,
    selectDetailLinks,
    compactSearchValue,
    primitiveMatchesQuery,
    objectIdentity,
    flattenPrimitiveContext,
    deepQueryJson,
    groupResolvedEntities,
    rankDataEndpoints,
  });
})(globalThis);
