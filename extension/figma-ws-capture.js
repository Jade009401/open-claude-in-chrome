// Figma WebSocket 抓帧(阶段 0 spike):MAIN world + document_start,在 Figma 打开 WS 前
// 猴补丁 WebSocket,被动收集二进制帧(scene graph 以 fig-kiwi 二进制从 WS 流下来)。
// 收齐后把帧打包成 JSON(base64)下载成 figma-frames.json,host 侧再用 figma-kiwi 解码验证。
// 只读、不改任何发送/回调,对 Figma 透明。无 token / 无插件 / 无调试端口 / 无黄条。
(() => {
  'use strict';
  if (window.__FIGMA_WS_CAPTURE__) return;
  window.__FIGMA_WS_CAPTURE__ = true;

  const TAG = '[figma-ws-capture]';
  const frames = []; // { bytes: Uint8Array, isSchema: boolean }
  const OrigWS = window.WebSocket;
  if (typeof OrigWS !== 'function') return;

  // fig-wire 帧:前 8 字节 == "fig-wire"(含 zstd 压缩的 kiwi schema)。魔数硬编码,避免 TextDecoder 开销。
  const FIG_MAGIC = [0x66, 0x69, 0x67, 0x2d, 0x77, 0x69, 0x72, 0x65]; // "fig-wire"
  function looksFigWire(bytes) {
    if (bytes.length < 12) return false;
    for (let i = 0; i < 8; i++) if (bytes[i] !== FIG_MAGIC[i]) return false;
    return true;
  }

  function record(data) {
    const push = (buf) => {
      const bytes = new Uint8Array(buf);
      if (bytes.length < 8) return; // 跳过心跳/控制小帧
      frames.push({ bytes, isSchema: looksFigWire(bytes) });
    };
    try {
      if (data instanceof ArrayBuffer) push(data);
      else if (ArrayBuffer.isView(data)) push(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
      else if (typeof Blob !== 'undefined' && data instanceof Blob) data.arrayBuffer().then(push).catch(() => {});
      // string 帧忽略(fig-kiwi 是二进制)
    } catch {}
  }

  class PatchedWebSocket extends OrigWS {
    constructor(...args) {
      super(...args);
      try {
        this.addEventListener('message', (ev) => { try { record(ev.data); } catch {} });
      } catch {}
    }
  }
  // 尽量让 Figma 侧感知不到替换(有代码可能读 .name)。
  try { Object.defineProperty(PatchedWebSocket, 'name', { value: 'WebSocket' }); } catch {}
  try { window.WebSocket = PatchedWebSocket; } catch (e) { console.warn(TAG, 'patch failed', e); return; }

  // Uint8Array → base64(分块避免 apply 参数上限)。
  function toB64(bytes) {
    let bin = '';
    const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    return btoa(bin);
  }

  // 保留全部 schema 帧 + 最大的若干 data 帧(丢掉小的增量/keepalive),避免 JSON 过大。
  // 生产按需 grab 只取 schema + 最大 2 个数据帧(全量帧最大);下载调试用更宽。
  function keptFrames(dataLimit = 2) {
    const schema = frames.filter((f) => f.isSchema);
    const data = frames.filter((f) => !f.isSchema).sort((a, b) => b.bytes.length - a.bytes.length);
    return { schema, keep: [...schema, ...data.slice(0, dataLimit)] };
  }
  function bundle(dataLimit = 6) {
    const { schema, keep } = keptFrames(dataLimit);
    return {
      url: location.href,
      total: frames.length,
      schemaFrames: schema.length,
      kept: keep.length,
      frames: keep.map((f) => ({ len: f.bytes.length, isSchema: f.isSchema, b64: toB64(f.bytes) })),
    };
  }

  function download() {
    const payload = bundle();
    try {
      const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
      const href = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = href;
      a.download = 'figma-frames.json';
      (document.body || document.documentElement).appendChild(a);
      a.click();
      setTimeout(() => { try { a.remove(); URL.revokeObjectURL(href); } catch {} }, 4000);
    } catch (e) {
      console.warn(TAG, 'download failed', e);
    }
    console.log(`${TAG} 下载 figma-frames.json:保留 ${payload.kept} 帧(schema ${payload.schemaFrames},总收到 ${payload.total})`);
    return payload;
  }

  // 生产落盘抓帧:把帧打包成二进制(不 base64,避免 39MB→53MB 膨胀 + 多趟 JSON 序列化)→ 原生下载,
  // 扩展侧经 chrome.downloads 拿绝对路径交给 host 读盘。容器格式:
  //   [4字节 uint32 LE = 头 JSON 字节长][头 JSON: {url,total,frames:[{len,isSchema}]}][按序拼接的原始帧字节]
  function grabToDisk(basename) {
    const { schema, keep } = keptFrames(2);
    const header = JSON.stringify({
      url: location.href,
      total: frames.length,
      frames: keep.map((f) => ({ len: f.bytes.length, isSchema: f.isSchema })),
    });
    const headerBytes = new TextEncoder().encode(header);
    const lenBuf = new Uint8Array(4);
    new DataView(lenBuf.buffer).setUint32(0, headerBytes.length, true);
    const blob = new Blob([lenBuf, headerBytes, ...keep.map((f) => f.bytes)], { type: 'application/octet-stream' });
    const href = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = href;
    a.download = basename || 'figma-ws-frames.bin';
    (document.body || document.documentElement).appendChild(a);
    a.click();
    setTimeout(() => { try { a.remove(); URL.revokeObjectURL(href); } catch {} }, 8000);
    console.log(`${TAG} 落盘 ${a.download}:${keep.length} 帧(schema ${schema.length},总收到 ${frames.length}),${blob.size} 字节`);
    return { ok: true, basename: a.download, kept: keep.length, schemaFrames: schema.length, total: frames.length, bytes: blob.size };
  }

  // 生产:扩展经 executeScript(MAIN) 调 __figCaptureGrabToDisk(basename) 落盘取帧(schema + 最大数据帧);
  // __figCaptureStatus() 供扩展判断"大帧到了没"(dataMax=最大非 schema 帧字节)。
  // __figCaptureGrab()/__figCaptureDownload() 保留作手动调试兜底(base64 JSON)。
  window.__figCaptureGrab = () => bundle(2);
  window.__figCaptureGrabToDisk = grabToDisk;
  window.__figCaptureDownload = download;
  window.__figCaptureStatus = () => {
    const data = frames.filter((f) => !f.isSchema);
    return {
      total: frames.length,
      schema: frames.filter((f) => f.isSchema).length,
      dataMax: data.reduce((m, f) => Math.max(m, f.bytes.length), 0),
      sizes: frames.map((f) => f.bytes.length).sort((a, b) => b - a),
    };
  };

  console.log(`${TAG} 已装载(document_start,已替换 WebSocket)。被动收帧中;/figma-ws 时由扩展按需取。`);
})();
