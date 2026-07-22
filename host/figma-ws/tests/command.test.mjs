// /figma-ws 命令识别 + node-id 解析(纯函数)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isFigmaWsCommand, parseFigmaWsCommand, parseNodeId } from '../sidebar-command.mjs';
import { nodeIdToKey } from '../scope.mjs';

test('isFigmaWsCommand:仅 /figma-ws 命中,不误命中 /figma', () => {
  assert.equal(isFigmaWsCommand('/figma-ws'), true);
  assert.equal(isFigmaWsCommand('  /figma-ws 行情页'), true);
  assert.equal(isFigmaWsCommand('/figma'), false); // /figma 不能被 /figma-ws 命中
  assert.equal(isFigmaWsCommand('/figma 出提示词'), false);
  assert.equal(isFigmaWsCommand('/figma-wsx'), false);
});

test('parseFigmaWsCommand:抽页面名', () => {
  assert.deepEqual(parseFigmaWsCommand('/figma-ws 行情页'), { pageName: '行情页' });
  assert.deepEqual(parseFigmaWsCommand('/figma-ws'), { pageName: null });
});

test('parseNodeId:从 URL 抽 node-id;横杠形转 guid 键', () => {
  assert.equal(parseNodeId('https://www.figma.com/design/ABC/New-Biconomy?node-id=63503-40279'), '63503-40279');
  assert.equal(parseNodeId('https://www.figma.com/design/ABC/x?node-id=149106%3A66368&t=z'), '149106:66368');
  assert.equal(parseNodeId('https://www.figma.com/design/ABC/x'), null);
  // 下游 scope 键:两种形都要落到冒号键
  assert.equal(nodeIdToKey('63503-40279'), '63503:40279');
  assert.equal(nodeIdToKey('149106:66368'), '149106:66368');
});
