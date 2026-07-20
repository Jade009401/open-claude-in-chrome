class BuildLock {
  #pending = new Map();

  async run(key, builder) {
    const normalized = String(key);
    if (this.#pending.has(normalized)) return this.#pending.get(normalized);
    const promise = Promise.resolve().then(builder).finally(() => this.#pending.delete(normalized));
    this.#pending.set(normalized, promise);
    return promise;
  }

  has(key) { return this.#pending.has(String(key)); }
  size() { return this.#pending.size; }
}

export { BuildLock };
