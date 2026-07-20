import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pageKeyHash } from './page-key.mjs';
import { validateNavigationMap } from './map-schema.mjs';

function defaultDataRoot() {
  return process.env.CLAUDE_SIDEBAR_DATA_DIR
    || path.join(os.homedir(), 'Library', 'Application Support', 'ClaudeSidebarPureMap');
}

class MapStore {
  constructor(options = {}) {
    this.root = path.resolve(options.root || defaultDataRoot());
    this.mapsRoot = path.join(this.root, 'maps');
    fs.mkdirSync(this.mapsRoot, { recursive: true, mode: 0o700 });
  }

  directoryFor(pageKey) { return path.join(this.mapsRoot, pageKeyHash(pageKey)); }
  mapPath(pageKey) { return path.join(this.directoryFor(pageKey), 'map.json'); }
  metadataPath(pageKey) { return path.join(this.directoryFor(pageKey), 'metadata.json'); }
  failurePath(pageKey) { return path.join(this.directoryFor(pageKey), 'build-failure.json'); }
  contentPath(pageKey) { return path.join(this.directoryFor(pageKey), 'content.json'); }

  // Persistent body text (design amendment 2026-07-14): block texts live on
  // disk under the SAME staleness contract as anchors — replaced atomically on
  // explicit refresh, never expiring on their own, never sent to the model in
  // full (reads return the requested slice only).
  writeContent(pageKey, content = {}) {
    const blocks = Array.isArray(content.blocks) ? content.blocks : [];
    if (!blocks.length) return { ok: false, code: 'content_blocks_empty' };
    const dir = this.directoryFor(pageKey);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const target = this.contentPath(pageKey);
    const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
    const compact = {
      pageKey,
      mapVersion: Number(content.mapVersion || 0),
      savedAt: content.savedAt || new Date().toISOString(),
      blocks: blocks.map((block) => ({ type: String(block.type || 'paragraph'), text: String(block.text || '') })),
    };
    fs.writeFileSync(temp, `${JSON.stringify(compact)}\n`, { mode: 0o600 });
    fs.renameSync(temp, target);
    return { ok: true, path: target, blockCount: compact.blocks.length };
  }

  readContent(pageKey) {
    const file = this.contentPath(pageKey);
    try {
      const content = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Array.isArray(content?.blocks) || !content.blocks.length) return { ok: false, code: 'content_file_invalid', path: file };
      return { ok: true, content, path: file };
    } catch (error) {
      if (error?.code === 'ENOENT') return { ok: false, code: 'content_not_stored', path: file };
      return { ok: false, code: 'content_file_read_failed', error: String(error?.message || error), path: file };
    }
  }

  read(pageKey) {
    const file = this.mapPath(pageKey);
    try {
      const map = JSON.parse(fs.readFileSync(file, 'utf8'));
      const validation = validateNavigationMap(map);
      if (!validation.ok) return { ok: false, code: 'map_file_invalid', errors: validation.errors, path: file };
      return { ok: true, map, path: file };
    } catch (error) {
      if (error?.code === 'ENOENT') return { ok: false, code: 'page_map_not_initialized', path: file };
      return { ok: false, code: 'map_file_read_failed', error: String(error?.message || error), path: file };
    }
  }

  readFailure(pageKey) {
    const file = this.failurePath(pageKey);
    try {
      const failure = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!failure || failure.ok !== false || !failure.code) return { ok: false, code: 'map_build_failure_invalid', path: file };
      return { ok: true, failure, path: file };
    } catch (error) {
      if (error?.code === 'ENOENT') return { ok: false, code: 'map_build_failure_not_found', path: file };
      return { ok: false, code: 'map_build_failure_read_failed', error: String(error?.message || error), path: file };
    }
  }

  writeFailure(pageKey, failure = {}) {
    const dir = this.directoryFor(pageKey);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const target = this.failurePath(pageKey);
    const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
    const compact = {
      ok: false,
      code: String(failure.code || 'map_build_failed'),
      pageKey,
      page: failure.page || null,
      adapter: failure.adapter || null,
      mapCoverage: failure.mapCoverage || null,
      diagnostics: Array.isArray(failure.diagnostics) ? failure.diagnostics.slice(0, 8) : [],
      failedAt: failure.failedAt || new Date().toISOString(),
    };
    fs.writeFileSync(temp, `${JSON.stringify(compact, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temp, target);
    return { ok: true, path: target, failure: compact };
  }

  clearFailure(pageKey) {
    try { fs.rmSync(this.failurePath(pageKey), { force: true }); } catch {}
    return { ok: true };
  }

  write(map) {
    const validation = validateNavigationMap(map);
    if (!validation.ok) {
      const error = new Error(`Navigation map validation failed: ${validation.errors.join(', ')}`);
      error.code = 'map_validation_failed';
      error.validation = validation;
      throw error;
    }
    const dir = this.directoryFor(map.pageKey);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const target = this.mapPath(map.pageKey);
    const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(temp, `${JSON.stringify(map)}\n`, { mode: 0o600 });
    fs.renameSync(temp, target);
    const metadata = {
      pageKey: map.pageKey,
      mapHandle: map.mapHandle,
      mapVersion: map.mapVersion,
      title: map.page?.title || '',
      url: map.page?.url || '',
      adapter: map.adapter,
      anchorCount: map.anchors?.length || 0,
      createdAt: map.createdAt,
      updatedAt: map.updatedAt,
    };
    fs.writeFileSync(this.metadataPath(map.pageKey), `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
    this.clearFailure(map.pageKey);
    return { ok: true, path: target };
  }

  remove(pageKey) {
    fs.rmSync(this.directoryFor(pageKey), { recursive: true, force: true });
    return { ok: true };
  }

  list() {
    const output = [];
    for (const entry of fs.readdirSync(this.mapsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        const metadata = JSON.parse(fs.readFileSync(path.join(this.mapsRoot, entry.name, 'metadata.json'), 'utf8'));
        output.push(metadata);
      } catch {}
    }
    return output.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }
}

export { MapStore, defaultDataRoot };
