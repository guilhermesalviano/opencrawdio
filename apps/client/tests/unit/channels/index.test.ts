import { describe, expect, it, vi } from 'vitest';
import { ChannelsManager, type ChannelDefinition } from '../../../src/channels';

function createLogger() {
  return {
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
  };
}

describe('channels', () => {
  it('uses injected channel plugins', async () => {
    const stop = vi.fn();
    const start = vi.fn(() => stop);
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const definition: ChannelDefinition = {
      name: 'telegram',
      enabled: () => true,
      start,
      sendMessage,
    };
    const logger = createLogger();
    const agent = { handle: vi.fn() };
    const channels = new ChannelsManager(logger, agent, [definition]);

    channels.startAll();
    await channels.sendMessage('telegram', '123', 'hello');
    channels.stopAll();

    expect(start).toHaveBeenCalledWith(logger, agent);
    expect(sendMessage).toHaveBeenCalledWith(logger, '123', 'hello');
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
