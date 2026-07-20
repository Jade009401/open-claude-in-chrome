// 访问录读写:record/lookup 往返 + 不覆盖 + 空 featureMenu 不记。用临时文件隔离。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = path.join(os.tmpdir(), `qa-systems-test-${process.pid}.json`);
process.env.CLAUDE_SIDEBAR_QA_SYSTEMS_FILE = TMP;
const { lookup, record, load } = await import('../systems-memory.mjs');

test.after(() => { try { fs.unlinkSync(TMP); } catch {} });

test('未记录 → lookup 返回 null', () => {
  assert.equal(lookup('运营后台-VIP', '系统配置 > VIP配置'), null);
});

test('record 后 lookup 命中', () => {
  assert.equal(record('运营后台-VIP', '系统配置 > VIP配置', 'https://ea/vip'), true);
  assert.equal(lookup('运营后台-VIP', '系统配置 > VIP配置')?.url, 'https://ea/vip');
});

test('已有记录不覆盖(保留首次)', () => {
  assert.equal(record('运营后台-VIP', '系统配置 > VIP配置', 'https://ea/other'), false);
  assert.equal(lookup('运营后台-VIP', '系统配置 > VIP配置').url, 'https://ea/vip');
});

test('不同功能菜单各自独立', () => {
  assert.equal(record('运营后台-VIP', '系统配置 > 其他', 'https://ea/misc'), true);
  assert.equal(lookup('运营后台-VIP', '系统配置 > 其他').url, 'https://ea/misc');
  assert.equal(lookup('运营后台-VIP', '系统配置 > VIP配置').url, 'https://ea/vip');
});

test('空 featureMenu → 不记录、不命中', () => {
  assert.equal(record('sys', '', 'https://z'), false);
  assert.equal(lookup('sys', ''), null);
});

test('持久化到文件', () => {
  const raw = JSON.parse(fs.readFileSync(TMP, 'utf8'));
  assert.equal(raw['运营后台-VIP']['系统配置 > VIP配置'].url, 'https://ea/vip');
});
