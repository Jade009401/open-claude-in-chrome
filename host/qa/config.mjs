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

// —— QA 安全配置(host/qa/qa-config.json,不进 git)——
// 缺文件时 fail-safe:白名单为空 = 全拒;关键词/动作用内置默认。
const QA_CONFIG_PATH = join(HERE, 'qa-config.json');
const DEFAULT_WRITE_KEYWORDS = ['删除', '支付', '提交', '下单', '确认付款', 'approve', 'delete', 'pay', 'submit', 'remove'];
const DEFAULT_WRITE_ACTIONS = ['click', 'input', 'select', 'submit'];
// 自动导航后若被重定向到含这些关键词的 URL,判为登录页 → 暂停等用户登录。上线按实际后台登录路径调。
const DEFAULT_LOGIN_URL_KEYWORDS = ['login', 'signin', 'sign-in', 'sso', 'passport', '/auth', 'oauth'];

export function loadQaConfig() {
  let file = {};
  try {
    file = JSON.parse(readFileSync(QA_CONFIG_PATH, 'utf8'));
  } catch {
    // 无配置文件:走 fail-safe 默认(白名单空=全拒)
  }
  return {
    envWhitelist: Array.isArray(file.envWhitelist) ? file.envWhitelist : [],
    writeKeywords: Array.isArray(file.writeKeywords) ? file.writeKeywords : DEFAULT_WRITE_KEYWORDS,
    writeActions: Array.isArray(file.writeActions) ? file.writeActions : DEFAULT_WRITE_ACTIONS,
    loginUrlKeywords: Array.isArray(file.loginUrlKeywords) ? file.loginUrlKeywords : DEFAULT_LOGIN_URL_KEYWORDS,
  };
}
