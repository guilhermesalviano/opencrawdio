class ExtensionPoint<T> {
  declare protected readonly _type: T;
  constructor(readonly id: string) {}
}

class PluginRegistry {
  private readonly store = new Map<string, unknown[]>();

  extend<T>(point: ExtensionPoint<T>, value: T): void {
    const existing = this.store.get(point.id);
    if (existing) {
      (existing as T[]).push(value);
    } else {
      this.store.set(point.id, [value]);
    }
  }

  collect<T>(point: ExtensionPoint<T>): T[] {
    return (this.store.get(point.id) as T[] | undefined) ?? [];
  }
}

interface Plugin {
  name: string;
  setup(registry: PluginRegistry): void;
}

export { ExtensionPoint, PluginRegistry };
export type { Plugin };
