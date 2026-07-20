import crypto from 'node:crypto';

const STRUCTURAL_QUERY_KEYS = new Set([
  'view', 'mode', 'layout', 'tab', 'section', 'route', 'workspace', 'project', 'type', 'panel',
]);

function normalizeUrl(rawUrl = '') {
  try {
    const url = new URL(String(rawUrl));
    url.hash = '';
    const kept = [...url.searchParams.entries()]
      .filter(([key]) => STRUCTURAL_QUERY_KEYS.has(String(key).toLowerCase()))
      .sort(([a, av], [b, bv]) => a.localeCompare(b) || av.localeCompare(bv));
    url.search = '';
    for (const [key, value] of kept) url.searchParams.append(key, value);
    url.pathname = url.pathname.replace(/\/{2,}/g, '/').replace(/\/$/, '') || '/';
    return url.toString();
  } catch {
    return String(rawUrl || '').trim();
  }
}

function larkIdentity(rawUrl = '') {
  try {
    const url = new URL(String(rawUrl));
    if (!/(?:larksuite|feishu)\.com$/i.test(url.hostname) && !/(?:larksuite|feishu)\.com/i.test(url.hostname)) return null;
    const match = url.pathname.match(/\/(?:wiki|docx|docs|base|sheets)\/([^/?#]+)/i);
    if (!match) return null;
    const workspace = url.hostname.toLowerCase();
    return `lark:${workspace}:${match[1]}`;
  } catch {
    return null;
  }
}

function figmaIdentity(rawUrl = '') {
  try {
    const url = new URL(String(rawUrl));
    if (!/figma\.com$/i.test(url.hostname) && !/figma\.com/i.test(url.hostname)) return null;
    const match = url.pathname.match(/\/(?:file|design|proto|board)\/([^/?#]+)/i);
    if (!match) return null;
    const branch = url.searchParams.get('branch-id') || 'main';
    return `figma:${match[1]}:${branch}`;
  } catch {
    return null;
  }
}

function pageKeyFor(identity = {}) {
  const url = String(identity.url || '');
  const lark = larkIdentity(url);
  if (lark) return lark;
  const figma = figmaIdentity(url);
  if (figma) return figma;
  const normalized = normalizeUrl(url);
  return `web:${normalized || `tab:${identity.tabId || 'unknown'}`}`;
}

function pageKeyHash(pageKey) {
  return crypto.createHash('sha256').update(String(pageKey)).digest('hex').slice(0, 32);
}

export { normalizeUrl, pageKeyFor, pageKeyHash, larkIdentity, figmaIdentity };
