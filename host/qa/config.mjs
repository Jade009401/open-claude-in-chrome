// QA 模块本地配置读取。
// 凭据只从 host/qa/.env.local 或环境变量读取,绝不硬编码、绝不打印明文。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENV_LOCAL = join(HERE, '.env.local');

// 极简 .env 解析:逐行 KEY=VALUE,跳过空行与 # 注释;不引 dotenv 依赖。
function parseEnvFile(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return {}; // 文件缺失时退回纯环境变量,不报错
  }
  const out = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // 去掉可能包裹的引号
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

const fileEnv = parseEnvFile(ENV_LOCAL);

// 优先环境变量,其次 .env.local。
function readVar(name) {
  return process.env[name] ?? fileEnv[name] ?? '';
}

export const larkAppId = readVar('LARK_APP_ID');
export const larkAppSecret = readVar('LARK_APP_SECRET');

// 断言凭据齐全,缺失时报清晰错误(绝不打印值)。
export function assertLarkCredentials() {
  const missing = [];
  if (!larkAppId) missing.push('LARK_APP_ID');
  if (!larkAppSecret) missing.push('LARK_APP_SECRET');
  if (missing.length) {
    throw new Error(
      `缺少飞书凭据: ${missing.join(', ')}(请在 host/qa/.env.local 配置)`,
    );
  }
}
