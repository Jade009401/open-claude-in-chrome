// 侧栏 /qa 命令:识别 + 解析(纯函数)。真跑靠侧栏发 /qa。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isQaCommand, parseQaCommand } from '../sidebar-command.mjs';

test('isQaCommand:仅 /qa 开头命中', () => {
  assert.equal(isQaCommand('/qa https://prd'), true);
  assert.equal(isQaCommand('  /qa'), true);
  assert.equal(isQaCommand('/qatest'), false); // 不是 /qa 空格分隔
  assert.equal(isQaCommand('你好'), false);
  assert.equal(isQaCommand('/help'), false);
});

test('parseQaCommand:抽 PRD链接 + 被测页URL', () => {
  assert.deepEqual(parseQaCommand('/qa https://prd https://target'), { prdUrl: 'https://prd', targetUrl: 'https://target' });
  assert.deepEqual(parseQaCommand('/qa https://prd'), { prdUrl: 'https://prd', targetUrl: null });
  assert.deepEqual(parseQaCommand('/qa'), { prdUrl: null, targetUrl: null });
});
