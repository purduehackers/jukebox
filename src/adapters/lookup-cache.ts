/** Bounded metadata reuse and in-flight deduplication; never retains failures. */
import { PortError } from '../core/ports.ts';
export class LookupCache<T> {
  private values = new Map<string, { until: number; value: T }>();
  private pending = new Map<string, Promise<T>>();
  private ttlMs: number;
  private limit: number;
  constructor(ttlMs = 300000, limit = 128) { this.ttlMs = ttlMs; this.limit = limit; }
  async get(key: string, load: () => Promise<T>): Promise<T> {
    const cached = this.values.get(key);
    if (cached && cached.until > Date.now()) return structuredClone(cached.value);
    let task = this.pending.get(key);
    if (!task) {
      if (this.pending.size >= this.limit) throw new PortError('SOURCE_UNAVAILABLE', 'Music lookup is busy; try again shortly.', true);
      task = load().then(value => {
        if (this.values.size >= this.limit) this.values.delete(this.values.keys().next().value!);
        this.values.set(key, { until: Date.now() + this.ttlMs, value: structuredClone(value) });
        return value;
      }).finally(() => this.pending.delete(key));
      this.pending.set(key, task);
    }
    return structuredClone(await task);
  }
}
export async function timedLookup<T>(stage: string, load: () => Promise<T>): Promise<T> {
  const start = performance.now(); let ok = false;
  try { const result = await load(); ok = true; return result; }
  finally { console.info(JSON.stringify({ event: 'music_lookup', stage, durationMs: Math.round(performance.now() - start), ok })); }
}
