import type {
  ActorContext,
  ActorStorage,
  ListOptions,
  StorageTransaction,
  SqlStorage,
} from '@telnyx/edge-runtime';

class MockActorStorage implements ActorStorage {
  private store = new Map<string, unknown>();
  private alarmAt: number | null = null;

  async get<T = unknown>(key: string): Promise<T | undefined> {
    return this.store.has(key) ? (this.store.get(key) as T) : undefined;
  }

  async put<T = unknown>(key: string, value: T): Promise<void> {
    this.store.set(key, value);
  }

  async delete(key: string): Promise<boolean> {
    return this.store.delete(key);
  }

  async list<T = unknown>(options?: ListOptions): Promise<Map<string, T>> {
    const prefix = options?.prefix ?? '';
    const entries = [...this.store.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .sort(([a], [b]) => (options?.reverse ? b.localeCompare(a) : a.localeCompare(b)));
    const limit = options?.limit ?? 128;
    return new Map(entries.slice(0, limit) as [string, T][]);
  }

  async deleteAll(): Promise<void> {
    this.store.clear();
  }

  async transaction<T>(fn: (txn: StorageTransaction) => Promise<T>): Promise<T> {
    throw new Error('transaction not implemented in MockActorStorage — DaySlotActor does not use it');
    // eslint-disable-next-line no-unreachable
    return fn as unknown as T;
  }

  transactionSync<T>(_fn: () => T): T {
    throw new Error('transactionSync not implemented in MockActorStorage — DaySlotActor does not use it');
  }

  get sql(): SqlStorage {
    throw new Error('sql not implemented in MockActorStorage — DaySlotActor does not use it');
  }

  async setAlarm(when: number): Promise<void> {
    this.alarmAt = when;
  }

  async getAlarm(): Promise<number | null> {
    return this.alarmAt;
  }

  async deleteAlarm(): Promise<void> {
    this.alarmAt = null;
  }
}

export function createMockActorContext(id = 'test-actor'): ActorContext & { storage: MockActorStorage } {
  const storage = new MockActorStorage();
  return {
    id,
    storage,
    async blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T> {
      return fn();
    },
    setAlarm: (when: number) => storage.setAlarm(when),
    count: () => 0,
    broadcast: () => 0,
    sockets: () => [],
  };
}
