/**
 * Share identical in-flight work, never retain settled results.
 * @spec Code quality from analysis
 */
export class PendingWork<T> {
  private readonly pending = new Map<string, Promise<T>>();

  run(key: string, build: () => Promise<T>): Promise<T> {
    const current = this.pending.get(key);
    if (current) return current;
    // Defer build so even a synchronous throw becomes a shared rejection.
    const work = Promise.resolve().then(build).finally(() => {
      if (this.pending.get(key) === work) this.pending.delete(key);
    });
    this.pending.set(key, work);
    return work;
  }
}
