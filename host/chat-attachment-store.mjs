import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const MAX_FILES = 4;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 24 * 1024 * 1024;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const ROOT = process.env.CLAUDE_SIDEBAR_ATTACHMENT_DIR
  || path.join(os.homedir(), 'Library', 'Application Support', 'ClaudeSidebarHost', 'attachments');

function sanitizeName(input) {
  const original = String(input || 'attachment').normalize('NFKC');
  const base = path.basename(original).replace(/[\u0000-\u001f\u007f]/g, '').replace(/[\\/:*?"<>|]/g, '_').trim();
  const safe = (base || 'attachment').slice(0, 180);
  return safe === '.' || safe === '..' ? 'attachment' : safe;
}

function safeSegment(input) {
  return String(input || 'session')
    .normalize('NFKC')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'session';
}

function ensureInside(root, target) {
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('attachment path escaped storage root');
}

function decodeBase64(value) {
  const data = String(value || '');
  if (!data || data.length > Math.ceil(MAX_FILE_BYTES * 4 / 3) + 16) throw new Error('invalid or oversized attachment payload');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new Error('attachment payload is not valid base64');
  return Buffer.from(data, 'base64');
}

function findPromptTarget(message) {
  for (const key of ['prompt', 'text', 'content', 'message']) {
    if (typeof message?.[key] === 'string') return { target: message, key };
  }
  for (const containerKey of ['message', 'payload', 'input', 'data']) {
    const nested = message?.[containerKey];
    if (!nested || typeof nested !== 'object' || Array.isArray(nested)) continue;
    for (const key of ['prompt', 'text', 'content']) {
      if (typeof nested[key] === 'string') return { target: nested, key };
    }
  }
  return null;
}

function extractPromptText(message) {
  const found = findPromptTarget(message);
  return found ? String(found.target[found.key] || '') : '';
}

export function determineAttachmentRouting(prompt) {
  const text = String(prompt || '').normalize('NFKC').trim();
  const explicitBrowser = /(?:浏览器(?:页面|网页)?|当前(?:打开的)?网页|当前浏览器|打开的网页|活动标签页|标签页|tab\b|browser\b|webpage\b|website\b)/i.test(text);
  const explicitAttachment = /(?:附件|上传的?(?:图片|文件|截图|文档)|这张(?:图|图片|截图)|这个文件|这份(?:文件|文档)|PDF|图片|截图|文件)/i.test(text);
  const explicitCombined = /(?:同时|一起|结合|对比|比较|分别|以及|并且|一并|both\b|compare\b|alongside\b)/i.test(text);

  if (explicitBrowser) {
    return {
      mode: 'attachment_first_then_browser',
      priority: 'attachment',
      browserAllowed: true,
      reason: explicitAttachment || explicitCombined
        ? 'The user explicitly requested both attachment and browser context.'
        : 'The user explicitly referenced the browser page; attachments must still be inspected first.',
    };
  }

  return {
    mode: 'attachment_only',
    priority: 'attachment',
    browserAllowed: false,
    reason: 'Attachments are present and the request does not explicitly reference the browser. Ambiguous words such as 页面 refer to the attachment.',
  };
}

function buildContext(files, prompt) {
  const lines = files.map((file, index) =>
    `${index + 1}. ${file.name} (${file.mimeType}, ${file.size} bytes)\n   Local path: ${file.path}`
  );
  const routing = determineAttachmentRouting(prompt);
  const browserRule = routing.browserAllowed
    ? 'After the relevant attachments have been successfully inspected, browser tools may be used only for the explicitly requested browser portion.'
    : 'Do not call browser, page-context, Lark, screenshot, DOM, or web-app tools in this turn. The active browser page is not the target.';
  return {
    routing,
    context: `<claude_sidebar_attachment_routing priority="hard" mode="${routing.mode}">\n` +
      `This turn contains user attachments. Attachment analysis has priority over the active browser page.\n` +
      `Mandatory first step: inspect every relevant attachment at the local paths below with the appropriate local file/image/PDF/document tool.\n` +
      `When the user says ambiguous phrases such as “这个页面”, “这个”, “这张”, or “分析一下”, interpret them as referring to the attached file or image, not the currently open browser tab.\n` +
      `${browserRule}\n` +
      `Never claim the attachment was analyzed until a file-reading tool has successfully read it.\n` +
      `</claude_sidebar_attachment_routing>\n\n` +
      `<claude_sidebar_attachments>\nThe user attached the following local files to this turn:\n${lines.join('\n')}\n\n` +
      `For images, inspect the actual image pixels; do not infer content from the filename. For PDFs, documents, spreadsheets, archives, or source files, use the appropriate reader/tool.\n` +
      `</claude_sidebar_attachments>`
  };
}

export function cleanupOldAttachments({ now = Date.now(), retentionMs = RETENTION_MS } = {}) {
  let removed = 0;
  try {
    if (!fs.existsSync(ROOT)) return { ok: true, removed };
    for (const entry of fs.readdirSync(ROOT, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const target = path.join(ROOT, entry.name);
      let stat;
      try { stat = fs.statSync(target); } catch { continue; }
      if (now - stat.mtimeMs < retentionMs) continue;
      fs.rmSync(target, { recursive: true, force: true });
      removed += 1;
    }
  } catch (error) {
    return { ok: false, removed, error: error.message };
  }
  return { ok: true, removed };
}

export function prepareChatMessageAttachments(message, options = {}) {
  const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
  if (!attachments.length) return { ok: true, files: [], message };
  if (attachments.length > MAX_FILES) throw new Error(`too many attachments: maximum is ${MAX_FILES}`);

  let declaredTotal = 0;
  for (const attachment of attachments) {
    const size = Number(attachment?.size || 0);
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_FILE_BYTES) {
      throw new Error(`attachment ${sanitizeName(attachment?.name)} exceeds the 10 MB limit or has an invalid size`);
    }
    declaredTotal += size;
  }
  if (declaredTotal > MAX_TOTAL_BYTES) throw new Error('attachment total exceeds the 24 MB limit');

  fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 });
  const session = safeSegment(options.sessionId || message.sessionId || message.session_id || message.requestedSessionId || 'session');
  const turnDir = path.join(ROOT, `${session}-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID()}`);
  ensureInside(ROOT, turnDir);
  fs.mkdirSync(turnDir, { recursive: true, mode: 0o700 });

  const files = [];
  try {
    for (let index = 0; index < attachments.length; index += 1) {
      const attachment = attachments[index] || {};
      const buffer = decodeBase64(attachment.data);
      const declaredSize = Number(attachment.size || 0);
      if (buffer.length !== declaredSize) {
        throw new Error(`attachment size mismatch for ${sanitizeName(attachment.name)}: declared ${declaredSize}, decoded ${buffer.length}`);
      }
      const safeName = sanitizeName(attachment.name);
      const prefix = String(index + 1).padStart(2, '0');
      const finalPath = path.join(turnDir, `${prefix}-${safeName}`);
      const tempPath = `${finalPath}.part`;
      ensureInside(ROOT, finalPath);
      fs.writeFileSync(tempPath, buffer, { mode: 0o600, flag: 'wx' });
      fs.renameSync(tempPath, finalPath);
      files.push({
        id: String(attachment.id || ''),
        name: safeName,
        mimeType: String(attachment.mimeType || 'application/octet-stream').slice(0, 200),
        size: buffer.length,
        sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
        path: finalPath,
      });
    }

    const originalPrompt = extractPromptText(message);
    const { context, routing } = buildContext(files, originalPrompt);
    const promptTarget = findPromptTarget(message);
    if (promptTarget) {
      promptTarget.target[promptTarget.key] = `${context}\n\n<user_request>\n${originalPrompt}\n</user_request>`;
    } else {
      message.prompt = `${context}\n\n<user_request>\n请读取并分析附件。\n</user_request>`;
    }
    message.attachmentRefs = files;
    message.attachmentRouting = routing;
    delete message.attachments;
    cleanupOldAttachments();
    return { ok: true, files, message };
  } catch (error) {
    try { fs.rmSync(turnDir, { recursive: true, force: true }); } catch {}
    throw error;
  }
}

export const chatAttachmentLimits = Object.freeze({
  maxFiles: MAX_FILES,
  maxFileBytes: MAX_FILE_BYTES,
  maxTotalBytes: MAX_TOTAL_BYTES,
  retentionMs: RETENTION_MS,
  root: ROOT,
});
