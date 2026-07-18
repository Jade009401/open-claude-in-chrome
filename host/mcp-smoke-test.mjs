#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, "mcp-server.js");
const larkAdapterPath = path.join(here, "lark-adapter.js");
const requiredTools = (process.env.CLAUDE_SIDEBAR_MCP_REQUIRED_TOOLS ||
  "tabs_context_mcp,read_page,lark_read,lark_search,lark_patch")
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean);
const timeoutMs = Number(process.env.CLAUDE_SIDEBAR_MCP_SMOKE_TIMEOUT_MS || 12_000);

let stderrText = "";
let timer = null;
const client = new Client({
  name: "claude-sidebar-mcp-smoke-test",
  version: "1.0.0",
});
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  cwd: here,
  stderr: "pipe",
  env: { ...process.env },
});

transport.stderr?.on("data", (chunk) => {
  stderrText += chunk.toString("utf8");
  if (stderrText.length > 32_000) stderrText = stderrText.slice(-32_000);
});

function timeoutPromise() {
  return new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`MCP initialize/tools-list timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
}

function parseToolPayload(result) {
  const text = (result?.content || [])
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

async function assertBrowserSessionAutoRouting() {
  const source = fs.readFileSync(serverPath, "utf8");
  const registration = source.match(/const larkAdapter = registerLarkAdapter\(\{[\s\S]*?\n\}\);/);
  if (!registration || !/\bsendToExtension\s*,/.test(registration[0])) {
    throw new Error("MCP Lark adapter registration is not wired with sendToExtension; Browser Session backend would be unavailable.");
  }

  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "claude-sidebar-lark-routing-"));
  const oldHome = process.env.HOME;
  try {
    process.env.HOME = tempHome;
    const configDir = process.platform === "darwin"
      ? path.join(tempHome, "Library", "Application Support", "ClaudeSidebarHost")
      : path.join(tempHome, ".config", "claude-sidebar");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "lark-adapter.json"),
      JSON.stringify({ appId: "invalid-app-id", appSecret: "invalid-app-secret", domain: "lark" }),
      { mode: 0o600 },
    );

    const moduleUrl = `${pathToFileURL(larkAdapterPath).href}?smoke=${Date.now()}`;
    const { registerLarkAdapter } = await import(moduleUrl);
    const handlers = new Map();
    const fakeServer = {
      tool(name, _description, _schema, handler) {
        handlers.set(name, handler);
        return {
          name,
          disable() {},
          enable() {},
        };
      },
    };
    let openApiClientCalls = 0;
    const extensionCalls = [];
    const context = {
      tabId: 830201858,
      title: "Open-Claude in Chrome使用文档 - Lark云文档",
      url: "https://puvrou0495.sg.larksuite.com/wiki/EoWCwavZziuXDSk1QCelp8SfgOb",
    };

    registerLarkAdapter({
      server: fakeServer,
      z,
      getContext: () => context,
      clientFactory: async () => {
        openApiClientCalls += 1;
        throw new Error("OpenAPI client must not be used for current-page auto routing in this smoke test.");
      },
      sendToExtension: async (tool, args) => {
        extensionCalls.push({ tool, args });
        return {
          ok: true,
          backend: "browser_session",
          sessionFrameId: 27,
          page: { tabId: context.tabId, url: context.url },
          blocks: [],
        };
      },
    });

    const larkRead = handlers.get("lark_read");
    if (typeof larkRead !== "function") throw new Error("lark_read handler was not registered in backend routing smoke test.");
    const result = await larkRead({ scope: "outline", backend: "auto" });
    const payload = parseToolPayload(result);
    if (!payload?.ok || payload.backend !== "browser_session" || payload.sessionFrameId !== 27) {
      throw new Error(`Auto backend did not route the current Lark page to Browser Session: ${JSON.stringify(payload)}`);
    }
    if (openApiClientCalls !== 0) {
      throw new Error(`Auto backend touched OpenAPI ${openApiClientCalls} time(s) even though the current page had Browser Session capability.`);
    }
    if (extensionCalls.length !== 1 || extensionCalls[0]?.tool !== "lark_session" || extensionCalls[0]?.args?.action !== "read") {
      throw new Error(`Browser Session backend did not dispatch lark_session/read: ${JSON.stringify(extensionCalls)}`);
    }

    return {
      backend: payload.backend,
      sessionFrameId: payload.sessionFrameId,
      openApiClientCalls,
      extensionTool: extensionCalls[0].tool,
      extensionAction: extensionCalls[0].args.action,
    };
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
}

try {
  const result = await Promise.race([
    (async () => {
      await client.connect(transport);
      const listed = await client.listTools();
      const names = new Set((listed.tools || []).map((tool) => tool.name));
      const missing = requiredTools.filter((name) => !names.has(name));
      if (missing.length > 0) {
        throw new Error(`MCP tools/list is missing required tools: ${missing.join(", ")}`);
      }
      const browserSessionRouting = await assertBrowserSessionAutoRouting();
      return {
        ok: true,
        toolCount: names.size,
        requiredTools,
        browserSessionRouting,
      };
    })(),
    timeoutPromise(),
  ]);
  console.log(JSON.stringify(result));
} catch (error) {
  const detail = stderrText.trim();
  console.error(`MCP smoke test failed: ${error?.stack || error?.message || String(error)}`);
  if (detail) {
    console.error("--- mcp-server stderr ---");
    console.error(detail);
    console.error("--- end mcp-server stderr ---");
  }
  process.exitCode = 1;
} finally {
  if (timer) clearTimeout(timer);
  try { await client.close(); } catch {}
}
