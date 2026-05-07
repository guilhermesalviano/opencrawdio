import fs from 'fs';
import path from 'path';
import { PluginRegistry, type Plugin } from './registry';

interface PluginModule {
  create?(): Plugin;
}

function createPlugins(): Plugin[] {
  return fs
    .readdirSync(__dirname, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const mod = require(path.join(__dirname, entry.name)) as PluginModule;
      return typeof mod.create === 'function' ? [mod.create()] : [];
    });
}

function buildRegistry(plugins: Plugin[]): PluginRegistry {
  const registry = new PluginRegistry();
  for (const plugin of plugins) {
    plugin.setup(registry);
  }
  return registry;
}

export { createPlugins, buildRegistry, PluginRegistry };
export type { Plugin };
