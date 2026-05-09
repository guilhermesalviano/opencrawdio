import * as fs from 'node:fs';
import path from 'node:path';
import { PluginRegistry, type Plugin } from './registry';

type PluginDirectoryEntry = Pick<fs.Dirent, 'name' | 'isDirectory'>;

interface PluginModule {
  create?(): Plugin;
}

interface CreatePluginsOptions {
  directory?: string;
  readdirSync?: (directory: string, options: { withFileTypes: true }) => PluginDirectoryEntry[];
  loadModule?: (modulePath: string) => PluginModule;
}

function createPlugins(options: CreatePluginsOptions = {}): Plugin[] {
  const {
    directory = __dirname,
    readdirSync = fs.readdirSync as CreatePluginsOptions['readdirSync'],
    loadModule = (modulePath: string) => require(modulePath) as PluginModule,
  } = options;

  return readdirSync!(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const mod = loadModule(path.join(directory, entry.name));
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
