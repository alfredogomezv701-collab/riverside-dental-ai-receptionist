import type {
  KvNamespace,
  KvGetTextOptions,
  KvGetJsonOptions,
  KvPutOptions,
  KvListOptions,
  KvListResult,
} from '@telnyx/edge-runtime';

interface KvEntry {
  value: string;
  options?: KvPutOptions;
}

// Telnyx KV rejects every character outside this set (error 10015). A ':' separator once got
// through the unit tests because this fake accepted anything, and only failed on the live service.
function assertValidKey(key: string): void {
  if (!/^[a-zA-Z0-9\-_/=.]+$/.test(key)) throw new Error(`KV 10015 Invalid key format: ${key}`);
}

export class MockKvNamespace implements KvNamespace {
  store = new Map<string, KvEntry>();
  puts: Array<{ key: string; value: string; options?: KvPutOptions }> = [];
  /** Any put whose key matches throws, to exercise partial-failure / rollback paths. */
  failPutsMatching: RegExp | undefined;

  async get(key: string, options?: KvGetTextOptions): Promise<string | null>;
  async get<T>(key: string, options: KvGetJsonOptions): Promise<T | null>;
  async get(key: string, options?: KvGetTextOptions | KvGetJsonOptions): Promise<unknown> {
    assertValidKey(key);
    const entry = this.store.get(key);
    if (entry === undefined) return null;
    if (options?.type === 'json') return JSON.parse(entry.value);
    return entry.value;
  }

  async put(key: string, value: string, options?: KvPutOptions): Promise<void> {
    assertValidKey(key);
    if (this.failPutsMatching?.test(key)) throw new Error(`injected KV put failure for ${key}`);
    this.puts.push({ key, value, options });
    this.store.set(key, { value, options });
  }

  async delete(key: string): Promise<void> {
    assertValidKey(key);
    this.store.delete(key);
  }

  async list(options?: KvListOptions): Promise<KvListResult> {
    const prefix = options?.prefix ?? '';
    return {
      keys: [...this.store.keys()].filter((k) => k.startsWith(prefix)).sort().map((name) => ({ name })),
      list_complete: true,
    };
  }
}
