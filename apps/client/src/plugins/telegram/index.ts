import { getBot, initBot, type InlineKeyboardMarkup, type TelegramMessage } from 'assistant-telegram-bot';
import type { ChannelDefinition } from '../../channels';
import { ADAPTERS } from '../../channels';
import type { ILogger } from '../../infrastructure/logger';
import type { Plugin, PluginRegistry } from '../registry';
import type { IAgent } from '../../services/agents/main-agent/agent';
import { stripInternalStreamMarkers } from '../../utils/stream-markers';
import { config } from '../../config';

const TYPING_INTERVAL_MS = 5_000;
const TELEGRAM_MESSAGE_LIMIT = 4_000;

interface TelegramBotClient {
  sendChatAction(chatId: number, action: 'typing'): Promise<unknown>;
  sendMessage(chatId: number, text: string, options?: Record<string, unknown>): Promise<unknown>;
}

interface ITelegramChannel {
  handleMessage(agent: IAgent, msg: TelegramMessage): Promise<void>;
  sendText(chatId: number, text: string): Promise<void>;
  sendCode(chatId: number, code: string, language?: string): Promise<void>;
  sendWithApproval(logger: ILogger, chatId: number, message: string, callbackData: string): Promise<void>;
}

interface TelegramChannelStartOptions {
  token: string;
  agent: IAgent;
  logger: ILogger;
}

interface TelegramPluginOptions {
  token: string;
}

class TelegramChannel implements ITelegramChannel {
  constructor(private readonly bot?: TelegramBotClient) {}

  async handleMessage(agent: IAgent, msg: TelegramMessage): Promise<void> {
    const { id: chatId } = msg.chat;
    const { text } = msg;

    if (!text) {
      return;
    }

    await this.processAndReply(agent, chatId, text);
  }

  async sendText(chatId: number, text: string): Promise<void> {
    for (const chunk of splitMessage(text, TELEGRAM_MESSAGE_LIMIT)) {
      await this.sendMessageWithMarkdownFallback(chatId, chunk);
    }
  }

  async sendCode(chatId: number, code: string, language: string = ''): Promise<void> {
    await this.getBotClient().sendMessage(chatId, `\`\`\`${language}\n${code}\n\`\`\``, { parse_mode: 'Markdown' });
  }

  async sendWithApproval(
    logger: ILogger,
    chatId: number,
    message: string,
    callbackData: string,
  ): Promise<void> {
    logger.info(`Sending message with approval to chat ${chatId}: ${message}`);

    const keyboard: InlineKeyboardMarkup = {
      inline_keyboard: [
        [
          { text: '✅ Approve', callback_data: `approve:${callbackData}` },
          { text: '❌ Reject', callback_data: `reject:${callbackData}` },
        ],
      ],
    };

    await this.getBotClient().sendMessage(chatId, message, {
      parse_mode: 'Markdown',
      reply_markup: keyboard,
    });
  }

  private async processAndReply(agent: IAgent, chatId: number, text: string): Promise<void> {
    try {
      await this.withTypingIndicator(chatId, async () => {
        const response = await agent.handle(text);
        const resolved = await this.resolveResponse(response);
        await this.sendText(chatId, resolved);
      });
    } catch (error) {
      console.error('Error processing message:', error);
      await this.getBotClient().sendMessage(
        chatId,
        '❌ Sorry, I encountered an error processing your message. Please try again.',
      );
    }
  }

  private async sendMessageWithMarkdownFallback(chatId: number, text: string): Promise<void> {
    try {
      await this.getBotClient().sendMessage(chatId, text, { parse_mode: 'MarkdownV2' });
    } catch (error) {
      if (!this.isEntityParseError(error)) {
        throw error;
      }

      await this.getBotClient().sendMessage(chatId, text);
    }
  }

  private async resolveResponse(response: unknown): Promise<string> {
    if (typeof response === 'string') {
      return stripInternalStreamMarkers(response);
    }

    if (this.isAsyncIterable(response)) {
      let out = '';
      for await (const chunk of response) {
        out += chunk;
      }

      return stripInternalStreamMarkers(out);
    }

    return String(response);
  }

  private async withTypingIndicator<T>(chatId: number, work: () => Promise<T>): Promise<T> {
    try {
      await this.getBotClient().sendChatAction(chatId, 'typing');
    } catch {}

    const timer = setInterval(() => {
      void this.getBotClient().sendChatAction(chatId, 'typing').catch(() => {});
    }, TYPING_INTERVAL_MS);

    try {
      return await work();
    } finally {
      clearInterval(timer);
    }
  }

  private isAsyncIterable(value: unknown): value is AsyncIterable<string> {
    if (!value || typeof value !== 'object') {
      return false;
    }

    const maybe = value as { [Symbol.asyncIterator]?: unknown };
    return typeof maybe[Symbol.asyncIterator] === 'function';
  }

  private isEntityParseError(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }

    return /can't parse entities/i.test(error.message);
  }

  private getBotClient(): TelegramBotClient {
    return this.bot ?? getBot();
  }
}

class TelegramChannelFactory {
  static create(): ITelegramChannel {
    return new TelegramChannel();
  }

  static start(options: TelegramChannelStartOptions): { channel: ITelegramChannel; stop: () => void } {
    const channel = new TelegramChannel();
    const bot = initBot({
      token: options.token,
      polling: true,
      onMessage: (msg) => channel.handleMessage(options.agent, msg),
      onPollingError: (error) => options.logger.warn(`Telegram polling error: ${error.message}`),
    });

    options.logger.info('Telegram is ready!');

    return {
      channel,
      stop: () => bot.stopPolling(),
    };
  }

  static async sendText(chatId: number, text: string): Promise<void> {
    const channel = new TelegramChannel();
    await channel.sendText(chatId, text);
  }
}

const telegramChannel = TelegramChannelFactory.create();

async function handleMessage(agent: IAgent, msg: TelegramMessage): Promise<void> {
  await telegramChannel.handleMessage(agent, msg);
}

async function sendCode(chatId: number, code: string, language?: string): Promise<void> {
  await telegramChannel.sendCode(chatId, code, language);
}

async function sendText(chatId: number, text: string): Promise<void> {
  await telegramChannel.sendText(chatId, text);
}

async function sendWithApproval(
  logger: ILogger,
  chatId: number,
  message: string,
  callbackData: string,
): Promise<void> {
  await telegramChannel.sendWithApproval(logger, chatId, message, callbackData);
}

function createTelegramAdapter(options: TelegramPluginOptions): ChannelDefinition {
  return {
    name: 'telegram',
    enabled: () => options.token.length > 0,
    start: (logger: ILogger, agent: IAgent) => {
      const { stop } = TelegramChannelFactory.start({
        token: options.token,
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
  };
}

function createTelegramPlugin(options: TelegramPluginOptions): Plugin {
  return {
    name: 'telegram',
    setup(registry: PluginRegistry) {
      registry.extend(ADAPTERS, createTelegramAdapter(options));
    },
  };
}

export {
  createTelegramPlugin,
  handleMessage,
  ITelegramChannel,
  sendText,
  sendCode,
  sendWithApproval,
  TelegramChannel,
  TelegramChannelFactory,
};

export function create(): Plugin {
  return createTelegramPlugin({
    token: config.CHANNELS.TELEGRAM.BOT_TOKEN,
  });
}

function splitMessage(text: string, maxLength: number): string[] {
  if (!text) {
    return [];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLength) {
    const candidate = remaining.slice(0, maxLength);
    const splitIndex = Math.max(candidate.lastIndexOf('\n'), candidate.lastIndexOf(' '));
    const end = splitIndex > 0 ? splitIndex : maxLength;

    chunks.push(remaining.slice(0, end).trimEnd());
    remaining = remaining.slice(end).trimStart();
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}
