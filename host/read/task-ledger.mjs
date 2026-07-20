import crypto from 'node:crypto';

class TaskLedger {
  constructor(options = {}) {
    this.ttlMs = Number(options.ttlMs || 30 * 60 * 1000);
    this.maxTasks = Number(options.maxTasks || 64);
    this.tasks = new Map();
  }

  key(pageKey, targetId, options = {}) {
    return crypto.createHash('sha256')
      .update(JSON.stringify({ pageKey, targetId, mode: options.mode || 'default', maxChars: options.maxChars || null }))
      .digest('hex');
  }

  get(taskId, key) {
    this.cleanup();
    return this.tasks.get(String(taskId || ''))?.entries?.get(key) || null;
  }

  put(taskId, key, value) {
    if (!taskId) return;
    const id = String(taskId);
    let task = this.tasks.get(id);
    if (!task) {
      task = { createdAt: Date.now(), updatedAt: Date.now(), entries: new Map() };
      this.tasks.set(id, task);
    }
    task.updatedAt = Date.now();
    task.entries.set(key, value);
    this.cleanup();
  }

  cleanup() {
    const now = Date.now();
    for (const [id, task] of this.tasks) if (now - task.updatedAt > this.ttlMs) this.tasks.delete(id);
    while (this.tasks.size > this.maxTasks) this.tasks.delete(this.tasks.keys().next().value);
  }
}

export { TaskLedger };
