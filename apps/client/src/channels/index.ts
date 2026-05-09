import { ExtensionPoint } from '../../plugins/registry';
import type { ILogger } from '../infrastructure/logger';
import type { IAgent } from '../services/agents/main-agent/agent';

export type StopFn = () => void;

export interface ChannelDefinition {
  name: string;
  enabled: () => boolean;
  start: (logger: ILogger, agent: IAgent) => StopFn | void;
  sendMessage?: (logger: ILogger, target: string, message: string) => Promise<void>;
}

export interface IChannelsManager {
  startAll(): void;
  stopAll(): void;
  sendMessage(channel: string, target: string, message: string): Promise<void>;
}

class ChannelsManager implements IChannelsManager {
  private logger: ILogger;
  private agent: IAgent;
  private stopFns: StopFn[] = [];
  private channels: ChannelDefinition[];

  constructor(
    logger: ILogger,
    agent: IAgent,
    channels: ChannelDefinition[] = [],
  ) {
    this.logger = logger;
    this.agent = agent;
    this.channels = channels;
  }

  startAll() {
    for (const channel of this.channels) {
      if (!channel.enabled()) continue;
      this.logger.info(`Starting channel: ${channel.name}`);
      const stop = channel.start(this.logger, this.agent);
      if (typeof stop === 'function') this.stopFns.push(stop);
    }
  }

  stopAll() {
    this.logger.info("\n👋 Shutting down gracefully...");
    this.stopFns.forEach((stop) => stop());
  }

  async sendMessage(channel: string, target: string, message: string): Promise<void> {
    const definition = this.channels.find((current) => current.name === channel);

    if (!definition) {
      throw new Error(`Unknown channel: ${channel}`);
    }

    if (!definition.enabled()) {
      throw new Error(`Channel "${channel}" is not enabled.`);
    }

    if (!definition.sendMessage) {
      throw new Error(`Channel "${channel}" does not support outgoing messages.`);
    }

    await definition.sendMessage(this.logger, target, message);
  }
}

class ChannelsSingleton {
  private static instance: ChannelsManager;

  static getInstance(logger: ILogger, agent: IAgent, channels: ChannelDefinition[] = []): ChannelsManager {
    if (!ChannelsSingleton.instance) {
      const seen = new Set<string>();
      const duplicates = channels
        .map((c) => c.name)
        .filter((name) => (seen.has(name) ? true : (seen.add(name), false)));

      if (duplicates.length > 0) {
        throw new Error(
          `Duplicate channel names detected: ${[...new Set(duplicates)].join(', ')}. Each channel must have a unique name.`,
        );
      }

      ChannelsSingleton.instance = new ChannelsManager(logger, agent, channels);
    }
    return ChannelsSingleton.instance;
  }
}

export { ChannelsManager, ChannelsSingleton };

export const ADAPTERS = new ExtensionPoint<ChannelDefinition>('channels.adapters');
