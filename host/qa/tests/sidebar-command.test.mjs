// 侧栏 /qa 命令:识别 + 解析 + 报错人话化(纯函数)。真跑靠侧栏发 /qa。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isQaCommand, parseQaCommand, humanizeError, stageLabel } from '../sidebar-command.mjs';

test('isQaCommand:仅 /qa 开头命中', () => {
  assert.equal(isQaCommand('/qa https://prd'), true);
  assert.equal(isQaCommand('  /qa'), true);
  assert.equal(isQaCommand('/qatest'), false); // 不是 /qa 空格分隔
  assert.equal(isQaCommand('你好'), false);
  assert.equal(isQaCommand('/help'), false);
});

test('parseQaCommand:抽 PRD链接 + 被测页URL(兜底覆盖,可选)', () => {
  assert.deepEqual(parseQaCommand('/qa https://prd https://target'), { prdUrl: 'https://prd', targetUrl: 'https://target' });
  assert.deepEqual(parseQaCommand('/qa https://prd'), { prdUrl: 'https://prd', targetUrl: null });
  assert.deepEqual(parseQaCommand('/qa'), { prdUrl: null, targetUrl: null });
});

test('humanizeError:无被测目标 → 提示先打开页或手动指定', () => {
  const msg = humanizeError({ ok: false, stage: 'entry', reason: 'no_target' });
  assert.ok(msg.includes('被测页') && msg.includes('/qa'), msg);
});

test('humanizeError:白名单外 → 疑似生产被拒', () => {
  const msg = humanizeError({ ok: false, stage: 'prepare', error: { code: 'env_not_whitelisted' } });
  assert.ok(msg.includes('白名单'), msg);
});

test('humanizeError:非法 URL / 原生App / 路由缺行 各有专属人话', () => {
  assert.ok(humanizeError({ error: { code: 'invalid_url' } }).includes('合法 URL'));
  assert.ok(humanizeError({ error: { code: 'app_env_not_ready' } }).includes('原生 App'));
  assert.ok(humanizeError({ stage: 'routing', reason: '路由总表无此键: 运营后台-VIP' }).includes('QA路由总表'));
});

test('humanizeError:生成阶段校验失败带上原因', () => {
  const msg = humanizeError({ ok: false, stage: 'generate', reason: ['需求 R2 无步骤覆盖(漏测)'] });
  assert.ok(msg.includes('校验') && msg.includes('漏测'), msg);
});

test('stageLabel:阶段码 → 中文', () => {
  assert.equal(stageLabel('prepare'), '建图');
  assert.equal(stageLabel('replay'), '重放');
});
