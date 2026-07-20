import crypto from 'node:crypto';

// Lifecycle registry for tool requests dispatched to the browser transport.
//
// Every request is guaranteed to reach a terminal state through two timers:
// - idle timeout: no efficacious progress within idleTimeoutForTool(tool);
// - hard deadline: an absolute cap counted from creation that no amount of
//   progress can extend.
//
// Stages listed in nonEfficaciousStages (e.g. duplicate_request_waiting) are
// recorded for diagnostics but do not re-arm the idle timer, so a wedged
// duplicate echo can no longer keep a zombie request alive forever.
//
// Request ids carry a per-process random boot nonce. Bare counter ids reused
// across MCP server restarts previously collided inside the extension's
// inflight/completed maps, which merged unrelated requests ("different
// arguments waiting on the same stuck task") or replayed stale results.
class PendingRequestTracker {
  constructor(options = {}) {
    this.idleTimeoutForTool = typeof options.idleTimeoutForTool === 'function' ? options.idleTimeoutForTool : () => 60000;
    this.hardDeadlineMs = Number(options.hardDeadlineMs || 600000);
    this.nonEfficaciousStages = new Set(options.nonEfficaciousStages || ['duplicate_request_waiting']);
    this.onTimeout = typeof options.onTimeout === 'function' ? options.onTimeout : () => {};
    // Timers are unref'd in production so pending requests never keep the host
    // process alive; tests disable this so their event loop reaches the timers.
    this.unrefTimers = options.unrefTimers !== false;
    this.bootNonce = crypto.randomBytes(4).toString('hex');
    this.counter = 0;
    this.requests = new Map();
  }

  nextId() {
    this.counter += 1;
    return `${this.bootNonce}-${this.counter}`;
  }

  create(id, entry) {
    entry.createdAt = Date.now();
    this.requests.set(String(id), entry);
    this.arm(String(id), entry);
    return entry;
  }

  arm(id, entry) {
    if (entry.timer) clearTimeout(entry.timer);
    const idleMs = this.idleTimeoutForTool(entry.tool);
    const hardRemainingMs = entry.createdAt + this.hardDeadlineMs - Date.now();
    const reason = hardRemainingMs <= idleMs ? 'hard_deadline' : 'idle_timeout';
    const waitMs = Math.max(0, Math.min(idleMs, hardRemainingMs));
    entry.timer = setTimeout(() => {
      this.requests.delete(id);
      try { this.onTimeout(id, entry, reason); } catch {}
      const seconds = Math.round((reason === 'hard_deadline' ? this.hardDeadlineMs : idleMs) / 1000);
      const error = new Error(reason === 'hard_deadline'
        ? `Tool request exceeded the ${seconds}s hard deadline without terminal response. Last progress: ${entry.lastProgress?.stage || 'none'}`
        : `Tool request timed out after ${seconds}s without terminal response. Last progress: ${entry.lastProgress?.stage || 'none'}`);
      error.code = reason;
      entry.reject(error);
    }, waitMs);
    if (this.unrefTimers) entry.timer.unref?.();
  }

  touchProgress(id, progress) {
    const entry = this.requests.get(String(id || ''));
    if (!entry) return false;
    entry.lastProgress = progress || null;
    entry.lastProgressAt = new Date().toISOString();
    if (!this.nonEfficaciousStages.has(String(progress?.stage || ''))) this.arm(String(id), entry);
    return true;
  }

  settle(id) {
    const key = String(id || '');
    const entry = this.requests.get(key);
    if (!entry) return null;
    if (entry.timer) clearTimeout(entry.timer);
    this.requests.delete(key);
    return entry;
  }

  get size() {
    return this.requests.size;
  }
}

export { PendingRequestTracker };
