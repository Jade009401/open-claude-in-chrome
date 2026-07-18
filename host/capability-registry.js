export class CapabilityRegistry {
  constructor(server) {
    this.server = server;
    this.context = null;
    this.adapters = new Map();
  }

  registerAdapter({ id, matches, tools }) {
    if (!id || typeof matches !== "function" || !Array.isArray(tools)) {
      throw new Error("Invalid capability adapter registration");
    }
    if (this.adapters.has(id)) throw new Error(`Duplicate capability adapter: ${id}`);

    const adapter = {
      id,
      matches,
      tools,
      active: false,
      toolNames: tools.map((tool, index) => tool.__capabilityName || `${id}:${index + 1}`),
    };
    this.adapters.set(id, adapter);

    // Keep adapter tools in the MCP catalog so Claude Code Tool Search can
    // discover them reliably. Context activation is tracked separately and
    // enforced by the adapter handler itself.
    return adapter;
  }

  updateContext(context) {
    this.context = context || null;
    const changed = [];

    for (const adapter of this.adapters.values()) {
      const nextActive = Boolean(adapter.matches(this.context));
      if (adapter.active === nextActive) continue;
      adapter.active = nextActive;
      changed.push({ id: adapter.id, active: nextActive });
    }

    return changed;
  }

  snapshot() {
    return {
      context: this.context,
      adapters: Array.from(this.adapters.values()).map((adapter) => ({
        id: adapter.id,
        active: adapter.active,
        tools: adapter.tools.map((tool, index) => ({
          name: adapter.toolNames[index],
          enabled: tool.enabled,
        })),
      })),
    };
  }
}
