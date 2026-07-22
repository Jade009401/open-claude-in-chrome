// Figma 适配器本地配置。凭据只从 host/figma/.env.local 或环境变量读,绝不硬编码、绝不打印明文。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENV_LOCAL = join(HERE, '.env.local');

// 极简 .env 解析:逐行 KEY=VALUE,跳过空行与 # 注释;不引 dotenv。
function parseEnvFile(path) {
  let text;
  try { text = readFileSync(path, 'utf8'); } catch { return {}; } // 缺文件 → 退回纯环境变量
  const out = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

const fileEnv = parseEnvFile(ENV_LOCAL);
function readVar(name) { return process.env[name] ?? fileEnv[name] ?? ''; }

// Figma 个人访问令牌(scope: file_content:read)或组织签发的 Plan Access Token。
// 惰性读取(每次调用现取):便于测试用 env 覆盖,也更正确。
export function getFigmaToken() { return readVar('FIGMA_TOKEN'); }

// 断言 token 存在,缺失时报清晰错误(绝不打印值)。
export function assertFigmaToken() {
  if (!getFigmaToken()) {
    throw new Error('缺少 FIGMA_TOKEN(请在 host/figma/.env.local 配置;Figma→Settings→Security 生成,scope 勾 file_content:read)');
  }
}
