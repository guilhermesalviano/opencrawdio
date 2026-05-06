import { config } from "../config";
import { IAgent } from "../services/agents/main-agent/agent";
import { TelegramChannelFactory } from "./telegram";
import type { ILogger } from "../infrastructure/logger";

export type StopFn = () => void;

interface ChannelDefinition {
  name: string;
  enabled: () => boolean;
  start: (logger: ILogger, agent: IAgent) => StopFn | void;
  sendMessage?: (logger: ILogger, target: string, message: string) => Promise<void>;
}

interface IChannelsManager {
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

  static getInstance(logger: ILogger, agent: IAgent): ChannelsManager {
    if (!ChannelsSingleton.instance) {
      const channels = [
        {
          name: 'telegram',
          enabled: () => !!config.CHANNELS.TELEGRAM.BOT_TOKEN,
          start: (logger: ILogger, agent: IAgent) => {
            const { stop } = TelegramChannelFactory.start({
              token: config.CHANNELS.TELEGRAM.BOT_TOKEN,
              agent,
              logger,
            });
            return stop;
          },
          sendMessage: async (_logger: ILogger, target: string, message: string) => {
            const chatId = Number(target);

            if (!Number.isFinite(chatId)) {
              throw new Error(`Invalid Telegram chat ID: ${target}`);
            }

            await TelegramChannelFactory.sendText(chatId, message);
          },
        },
      ];

      ChannelsSingleton.instance = new ChannelsManager(logger, agent, channels);
    }
    return ChannelsSingleton.instance;
  }
}

export { IChannelsManager, ChannelsSingleton };
