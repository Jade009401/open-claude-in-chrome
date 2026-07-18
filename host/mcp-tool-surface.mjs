export const PURE_MAP_SERVER_NAME = 'claude-sidebar-pure-map';

export const PURE_MAP_TOOL_NAMES = Object.freeze([
  'browser_map',
  'browser_locate',
  'browser_read',
  'browser_act',
]);

export const PURE_MAP_CLAUDE_TOOL_NAMES = Object.freeze(
  PURE_MAP_TOOL_NAMES.map((name) => `mcp__${PURE_MAP_SERVER_NAME}__${name}`),
);

const LEGACY_BROWSER_TOOL_NAMES = new Set([
  'tabs_context_mcp','tabs_create_mcp','switch_browser','sidebar_connection_status',
  'navigate','resize_window','read_page','get_page_text','find','browser_page_context',
  'browser_app_inspect','browser_app_query','read_console_messages','read_network_requests',
  'computer','javascript_tool','form_input','shortcuts_list','shortcuts_execute',
  'update_plan','upload_image','gif_creator','lark_read','lark_search','lark_patch',
  'lark_locate','lark_query','lark_deep_read','lark_session','lark_session_start',
  'lark_index_status','lark_index_refresh','lark_index_cleanup','lark_requirement_read',
  'lark_document_summary','virtual_scroll_seek',
]);

function normalizeToolName(item) {
  if (typeof item === 'string') return item.trim();
  if (item && typeof item.name === 'string') return item.name.trim();
  return '';
}

function leafName(name) {
  const match = String(name).match(/^mcp__[^_].*?__([^]+)$/);
  return match ? match[1] : String(name);
}

function isExpectedTool(name) {
  return PURE_MAP_CLAUDE_TOOL_NAMES.includes(name) || PURE_MAP_TOOL_NAMES.includes(name);
}

function isForbiddenBrowserTool(name) {
  if (String(name).startsWith('mcp__open-claude-in-chrome__')) return true;
  const leaf = leafName(name);
  if (LEGACY_BROWSER_TOOL_NAMES.has(leaf)) return true;
  if (PURE_MAP_TOOL_NAMES.includes(leaf) && !isExpectedTool(name)) return true;
  return false;
}

export function validateClaudeToolSurface(tools) {
  if (!Array.isArray(tools)) {
    return {
      ok: false,
      reported: false,
      code: 'mcp_tool_surface_unreported',
      serverName: PURE_MAP_SERVER_NAME,
      expected: [...PURE_MAP_CLAUDE_TOOL_NAMES],
      actual: [],
      missing: [...PURE_MAP_CLAUDE_TOOL_NAMES],
      forbidden: [],
    };
  }

  const actual = [...new Set(tools.map(normalizeToolName).filter(Boolean))];
  const missing = PURE_MAP_TOOL_NAMES.filter((shortName, index) =>
    !actual.includes(shortName) && !actual.includes(PURE_MAP_CLAUDE_TOOL_NAMES[index]),
  ).map((shortName) => `mcp__${PURE_MAP_SERVER_NAME}__${shortName}`);
  const forbidden = actual.filter(isForbiddenBrowserTool);

  let code = 'mcp_tool_surface_ready';
  if (missing.length) code = 'mcp_tool_surface_missing';
  else if (forbidden.length) code = 'mcp_tool_surface_extra_browser_tools';

  return {
    ok: missing.length === 0 && forbidden.length === 0,
    reported: true,
    code,
    serverName: PURE_MAP_SERVER_NAME,
    expected: [...PURE_MAP_CLAUDE_TOOL_NAMES],
    actual,
    missing,
    forbidden,
  };
}

export function formatPureMapToolInventory(surface) {
  if (!surface?.ok) return null;
  return [
    '当前侧栏浏览器 MCP 只提供 4 个 Pure Map 工具：',
    '',
    '- `browser_map`：获取或首次建立页面级持久化稀疏地图；仅在用户明确要求时刷新',
    '- `browser_locate`：只查询本地地图索引，快速定位章节、表格、图层或控件',
    '- `browser_read`：按地图锚点实时读取目标内容，不重新生成地图',
    '- `browser_act`：对稳定锚点执行受控操作，不隐式刷新地图',
    '',
    `MCP 服务器：${PURE_MAP_SERVER_NAME}`,
  ].join('\n');
}
