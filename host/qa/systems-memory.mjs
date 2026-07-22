// 被测系统访问录(存项目记忆):按前端功能菜单记入口 URL,首次自动沉淀。
// 结构:{ [routeKey]: { [功能菜单路径]: { url, note, capturedAt } } }
// 路径:memory/qa-systems.json —— 由仓库根推导 Claude 项目记忆目录(slug=路径把 / 换成 -)。
// 可用 CLAUDE_SIDEBAR_QA_SYSTEMS_FILE 覆盖(测试/自定义)。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..'); // <repo>/host/qa → <repo>

function storeFile() {
  if (process.env.CLAUDE_SIDEBAR_QA_SYSTEMS_FILE) return process.env.CLAUDE_SIDEBAR_QA_SYSTEMS_FILE;
  const slug = REPO_ROOT.replace(/\//g, '-');
  return path.join(os.homedir(), '.claude', 'projects', slug, 'memory', 'qa-systems.json');
}

function load() {
  try {
    const obj = JSON.parse(fs.readFileSync(storeFile(), 'utf8'));
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
  } catch { return {}; }
}

function save(data) {
  const file = storeFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

// 查 (routeKey, 功能菜单) → { url, note } 或 null。功能菜单为空 → 不命中(退回首次/当前页)。
function lookup(routeKey, featureMenu) {
  const key = String(featureMenu || '').trim();
  if (!routeKey || !key) return null;
  const sys = load()[routeKey];
  const hit = sys && sys[key];
  return hit && hit.url ? hit : null;
}

// 沉淀:记 (routeKey, 功能菜单) → url。默认不覆盖已有(保留首次);
// force=true 时覆盖(用户显式给深链纠正错入口)。返回是否写入。
function record(routeKey, featureMenu, url, note, { force = false } = {}) {
  const key = String(featureMenu || '').trim();
  if (!routeKey || !key || !url) return false;
  const data = load();
  data[routeKey] = data[routeKey] || {};
  if (!force && data[routeKey][key]?.url) return false; // 非强制:已有不覆盖
  data[routeKey][key] = { url: String(url), note: String(note || ''), capturedAt: new Date().toISOString() };
  save(data);
  return true;
}

export { load, save, lookup, record, storeFile };
