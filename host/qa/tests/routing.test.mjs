// routing 纯函数测试(IO 部分靠真实飞书验证)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRoute, baseTokenFromUrl, cellText } from '../routing.mjs';

const ROUTES = [
  { 端: '用户端', 系统模块: '理财', 结果表链接: 'https://x.larksuite.com/base/AAA', 播报群名: '理财群' },
  { 端: '运营后台', 系统模块: '合约', 结果表链接: 'https://x.larksuite.com/base/BBB', 播报群名: '合约后台群' },
];

test('resolveRoute 命中(用户端-理财)', () => {
  const r = resolveRoute(ROUTES, '用户端-理财');
  assert.equal(r.ok, true);
  assert.equal(r.groupName, '理财群');
  assert.equal(r.resultTableUrl, 'https://x.larksuite.com/base/AAA');
});

test('resolveRoute 模块名含连字符也能切对(只切第一个 -)', () => {
  const routes = [{ 端: '用户端', 系统模块: 'a-b', 结果表链接: 'u', 播报群名: 'g' }];
  assert.equal(resolveRoute(routes, '用户端-a-b').ok, true);
});

test('resolveRoute 无此键 → ok:false', () => {
  assert.equal(resolveRoute(ROUTES, '用户端-支付').ok, false);
});

test('baseTokenFromUrl 抽 token', () => {
  assert.equal(baseTokenFromUrl('https://x.larksuite.com/base/AbgLbeDMHaz?table=tbl1'), 'AbgLbeDMHaz');
  assert.equal(baseTokenFromUrl('bad'), null);
});

test('cellText 兼容 字符串 / [{text}] / 对象', () => {
  assert.equal(cellText('hi'), 'hi');
  assert.equal(cellText([{ type: 'text', text: '甲' }, { text: '乙' }]), '甲乙');
  assert.equal(cellText({ text: '丙' }), '丙');
  assert.equal(cellText(null), '');
});
