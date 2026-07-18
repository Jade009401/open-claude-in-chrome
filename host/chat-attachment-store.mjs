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

function buildContext(files) {
  const lines = files.map((file, index) =>
    `${index + 1}. ${file.name} (${file.mimeType}, ${file.size} bytes)\n   Local path: ${file.path}`
  );
  return `\n\n<claude_sidebar_attachments>\nThe user attached the following local files to this turn:\n${lines.join('\n')}\n\nTreat these files as part of the user's message. Before answering, inspect every relevant file with the available local file-reading tools. For images, inspect the actual image pixels; do not infer content from the filename. For PDFs, documents, spreadsheets, archives, or source files, use the appropriate reader/tool. Do not claim a file was read unless the tool call succeeded.\n</claude_sidebar_attachments>`;
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

    const context = buildContext(files);
    const promptTarget = findPromptTarget(message);
    if (promptTarget) promptTarget.target[promptTarget.key] = `${promptTarget.target[promptTarget.key]}${context}`;
    else message.prompt = context.trimStart();
    message.attachmentRefs = files;
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
