// Task 1 测试:表格探测纯函数 hasTableBlock。
// readDoc 是网络 IO,不在单测里真调网络(靠 0a spike / 手工验证)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasTableBlock, extractRefs } from '../lark-client.mjs';

test('含表格块(block_type=31)返回 true', () => {
  const blocks = [
    { block_id: 'a', block_type: 2 }, // 文本
    { block_id: 'b', block_type: 31 }, // 表格
  ];
  assert.equal(hasTableBlock(blocks), true);
});

test('纯文本块返回 false', () => {
  const blocks = [
    { block_id: 'a', block_type: 2 },
    { block_id: 'c', block_type: 4 }, // heading 等非表格
  ];
  assert.equal(hasTableBlock(blocks), false);
});

test('块带 .table 字段也判为表格(数值口径兜底)', () => {
  const blocks = [{ block_id: 'a', block_type: 999, table: { column_size: 3 } }];
  assert.equal(hasTableBlock(blocks), true);
});

test('空数组 / 非数组返回 false,不抛错', () => {
  assert.equal(hasTableBlock([]), false);
  assert.equal(hasTableBlock(null), false);
  assert.equal(hasTableBlock(undefined), false);
});

// —— extractRefs:列出文档里的超链接 + @文档引用(A 方案:只列不跟读)——
test('抽出内嵌超链接(url 解码)', () => {
  const blocks = [
    { text: { elements: [
      { text_run: { content: '被测入口', text_element_style: { link: { url: 'https%3A%2F%2Ftest.example.com%2Flogin' } } } },
    ] } },
  ];
  const { links } = extractRefs(blocks);
  assert.equal(links.length, 1);
  assert.equal(links[0].text, '被测入口');
  assert.equal(links[0].url, 'https://test.example.com/login');
});

test('抽出 @ 文档引用(mention_doc)', () => {
  const blocks = [
    { text: { elements: [
      { mention_doc: { title: '测试数据文档', token: 'TOKEN123', obj_type: 16 } },
    ] } },
  ];
  const { mentions } = extractRefs(blocks);
  assert.equal(mentions.length, 1);
  assert.deepEqual(mentions[0], { title: '测试数据文档', token: 'TOKEN123', objType: 16 });
});

test('非 text 块(heading 等)里的链接也能抽出', () => {
  const blocks = [
    { heading1: { elements: [
      { text_run: { content: '标题链接', text_element_style: { link: { url: 'https%3A%2F%2Fa.com' } } } },
    ] } },
  ];
  const { links } = extractRefs(blocks);
  assert.equal(links.length, 1);
  assert.equal(links[0].url, 'https://a.com');
});

test('无链接/非数组时返回空,不抛错', () => {
  assert.deepEqual(extractRefs([{ text: { elements: [{ text_run: { content: '纯文本' } }] } }]), { links: [], mentions: [] });
  assert.deepEqual(extractRefs(null), { links: [], mentions: [] });
});
