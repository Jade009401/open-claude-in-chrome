// Task 0a spike:验证「应用身份」能否读专用知识库(Wiki)里的 PRD(国际版 Lark)。
// 目的:确认一次性授权是否覆盖 wiki 里的文档(spec §11 头号未决)。
// 用法:node host/qa/spikes/spike-lark-read.mjs "<wiki 或 docx 链接 / 裸 token>"
//   不传参时用下方默认测试 URL。
//
// 关键点(与旧计划 Task 0a Step3 的差异):
//   - 国际版 Lark 域名走 Domain.Lark(open.larksuite.com),非 Feishu。
//   - URL 是 wiki 节点时,token 是 node_token,不能直接喂 docx.rawContent;
//     须先 wiki.getNode 解析出 obj_token(=docx document_id)再读。
import * as lark from '@larksuiteoapi/node-sdk';
import { larkAppId, larkAppSecret, assertLarkCredentials } from '../config.mjs';

// 默认测试目标(用户提供的 wiki 节点)。可用命令行参数覆盖。
const DEFAULT_TARGET =
  'https://ejptbnbfbynw.jp.larksuite.com/wiki/Dw6PwpMqAigDMbk9d63jzV4rpxd';

// 权限类错误码(spec §11 关注):91403 无权限 / 131006 文档不存在或无访问权。
const PERMISSION_CODES = new Set([91403, 131006]);

// 从链接抽出 token 与类型。支持 /wiki/<token> 与 /docx/<token>;
// 也允许直接传裸 token(默认按 wiki 处理)。
function parseTarget(input) {
  const raw = String(input || '').trim();
  const wiki = raw.match(/\/wiki\/([A-Za-z0-9]+)/);
  if (wiki) return { kind: 'wiki', token: wiki[1] };
  const docx = raw.match(/\/docx\/([A-Za-z0-9]+)/);
  if (docx) return { kind: 'docx', token: docx[1] };
  if (/^[A-Za-z0-9]+$/.test(raw)) return { kind: 'wiki', token: raw };
  throw new Error(`无法从输入解析 token: ${raw}`);
}

function reportApiError(where, resp) {
  const code = resp.code;
  console.log(`[spike] ❌ ${where} 失败: code=${code} msg=${resp.msg}`);
  if (PERMISSION_CODES.has(code)) {
    console.log(
      `[spike] ⚠️ 命中权限类错误(${code})——按 spec §11:一次性授权可能不覆盖此文档,` +
        `需改「每篇授权」或用户 OAuth。停,把结论写回 spec §11。`,
    );
  }
}

async function main() {
  assertLarkCredentials();
  const target = parseTarget(process.argv[2] || DEFAULT_TARGET);
  console.log(`[spike] 目标: kind=${target.kind} token=${target.token}`);

  const client = new lark.Client({
    appId: larkAppId,
    appSecret: larkAppSecret,
    appType: lark.AppType.SelfBuild,
    domain: lark.Domain.Lark, // 国际版 larksuite.com
    loggerLevel: lark.LoggerLevel.error, // 压掉 SDK 的 info 噪声
  });

  // 1) wiki 节点先解析出 obj_token(docx 的 document_id)。
  let documentId = target.token;
  if (target.kind === 'wiki') {
    const nodeResp = await client.wiki.v2.space.getNode({
      params: { token: target.token },
    });
    if (nodeResp.code && nodeResp.code !== 0) {
      reportApiError('wiki.getNode', nodeResp);
      process.exitCode = 1;
      return;
    }
    const node = nodeResp.data?.node;
    console.log(
      `[spike] wiki 节点解析: obj_type=${node?.obj_type} title=${node?.title || '(无标题)'}`,
    );
    if (node?.obj_type !== 'docx') {
      console.log(
        `[spike] ⚠️ 节点不是 docx(是 ${node?.obj_type}),本 spike 只读 docx。停。`,
      );
      process.exitCode = 1;
      return;
    }
    documentId = node.obj_token;
  }

  // 2) 读 docx 纯文本内容。
  const contentResp = await client.docx.v1.document.rawContent({
    path: { document_id: documentId },
    params: { lang: 0 },
  });
  if (contentResp.code && contentResp.code !== 0) {
    reportApiError('docx.rawContent', contentResp);
    process.exitCode = 1;
    return;
  }
  const content = contentResp.data?.content || '';
  console.log(`[spike] ✅ 读到文档,总长 ${content.length} 字。前 500 字:`);
  console.log('─'.repeat(60));
  console.log(content.slice(0, 500));
  console.log('─'.repeat(60));
}

main().catch((err) => {
  // SDK 也可能抛异常(网络/token 无效等)。不打印凭据。
  console.log(`[spike] ❌ 异常: ${err?.message || err}`);
  const data = err?.response?.data;
  if (data) console.log(`[spike] 响应: code=${data.code} msg=${data.msg}`);
  process.exitCode = 1;
});
