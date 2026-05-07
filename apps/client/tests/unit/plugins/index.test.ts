import { describe, expect, it } from 'vitest';
import type { ChannelDefinition } from '../../../src/channels';
import { ADAPTERS } from '../../../src/channels';
import { buildRegistry, type Plugin } from '../../../src/plugins';

describe('plugins', () => {
  it('merges contributions across plugins', () => {
    const telegram: ChannelDefinition = {
      name: 'telegram',
      enabled: () => true,
      start: () => undefined,
    };
    const slack: ChannelDefinition = {
      name: 'slack',
      enabled: () => true,
      start: () => undefined,
    };
    const plugins: Plugin[] = [
      {
        name: 'notifications',
        setup(registry) { registry.extend(ADAPTERS, telegram); },
      },
      {
        name: 'support',
        setup(registry) { registry.extend(ADAPTERS, slack); },
      },
    ];

    const registry = buildRegistry(plugins);

    expect(registry.collect(ADAPTERS)).toEqual([telegram, slack]);
  });
});
