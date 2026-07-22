// 探测:用应用身份看飞书里建好了什么(只读)。
// 1) 知识库空间 → 2) 每个空间的节点(找「QA路由总表」+ 结果表)→ 3) 机器人在的群(拿 chat_id)。
import { createClient } from '../lark-client.mjs';

const c = createClient();

async function main() {
  // 1. 知识库空间
  console.log('=== 知识库空间 ===');
  const spaceResp = await c.wiki.v2.space.list({ params: { page_size: 50 } });
  if (spaceResp.code) { console.log(`space.list 失败 code=${spaceResp.code} msg=${spaceResp.msg}`); }
  const spaces = spaceResp.data?.items || [];
  for (const s of spaces) console.log(`- space_id=${s.space_id} name="${s.name}"`);

  // 2. 每个空间的节点(标题 + 类型 + token)
  console.log('\n=== 空间内节点(bitable=多维表格) ===');
  for (const s of spaces) {
    let pageToken;
    for (let i = 0; i < 5; i += 1) {
      const nodeResp = await c.wiki.v2.spaceNode.list({
        path: { space_id: s.space_id },
        params: { page_size: 50, ...(pageToken ? { page_token: pageToken } : {}) },
      });
      if (nodeResp.code) { console.log(`  [${s.name}] spaceNode.list 失败 code=${nodeResp.code} msg=${nodeResp.msg}`); break; }
      for (const n of nodeResp.data?.items || []) {
        console.log(`- [${s.name}] title="${n.title}" obj_type=${n.obj_type} obj_token=${n.obj_token}`);
      }
      if (!nodeResp.data?.has_more) break;
      pageToken = nodeResp.data?.page_token;
      if (!pageToken) break;
    }
  }

  // 3. 机器人在的群 → chat_id
  console.log('\n=== 机器人在的群(chat_id) ===');
  const chatResp = await c.im.v1.chat.list({ params: { page_size: 100 } });
  if (chatResp.code) { console.log(`chat.list 失败 code=${chatResp.code} msg=${chatResp.msg}`); }
  for (const ch of chatResp.data?.items || []) {
    console.log(`- chat_id=${ch.chat_id} name="${ch.name}"`);
  }
}

main().catch((e) => {
  console.log(`探测异常: ${e?.message || e}`);
  const d = e?.response?.data;
  if (d) console.log(`响应 code=${d.code} msg=${d.msg}`);
  process.exitCode = 1;
});
