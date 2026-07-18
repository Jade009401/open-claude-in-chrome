function textContentOf(result) {
  if (!result?.content || !Array.isArray(result.content)) return "";
  return result.content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

function decodeToolResult(raw) {
  if (raw && typeof raw === "object" && typeof raw.ok === "boolean") return raw;
  if (raw?.structuredContent && typeof raw.structuredContent === "object") return raw.structuredContent;
  const text = textContentOf(raw);
  if (text) {
    try { return JSON.parse(text); } catch {}
    return { ok: false, code: "session_invalid_result", error: text };
  }
  return { ok: false, code: "session_invalid_result", error: "Lark Browser Session backend returned no structured result." };
}

export function createLarkBrowserSessionBackend({ sendToExtension }) {
  if (typeof sendToExtension !== "function") {
    throw new Error("createLarkBrowserSessionBackend requires sendToExtension");
  }

  async function call(context, action, args) {
    const tabId = Number(context?.tabId);
    if (!Number.isFinite(tabId)) {
      return {
        ok: false,
        code: "session_missing_tab",
        error: "当前 Lark 页面没有可用 tabId，无法使用 Browser Session Backend。",
      };
    }

    try {
      const raw = await sendToExtension("lark_session", {
        action,
        tabId,
        ...args,
      });
      const payload = decodeToolResult(raw);
      return {
        backend: "browser_session",
        ...payload,
      };
    } catch (error) {
      return {
        ok: false,
        backend: "browser_session",
        code: "session_transport_error",
        error: error?.message || String(error),
      };
    }
  }

  return Object.freeze({
    read: (context, args) => call(context, "read", args),
    search: (context, args) => call(context, "search", args),
    patch: (context, args) => call(context, "patch", args),
  });
}

export const __larkSessionBackendTest = Object.freeze({
  decodeToolResult,
});
