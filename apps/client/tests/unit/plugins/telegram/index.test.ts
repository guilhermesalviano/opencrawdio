import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TelegramMessage } from 'assistant-telegram-bot';
import { RESPONSE_ANCHOR, THINK_END, THINK_START } from '../../../../src/constants/thinking';
import { handleMessage } from '../../../../src/plugins/telegram';

const bot = vi.hoisted(() => ({
  sendChatAction: vi.fn(),
  sendMessage: vi.fn(),
}));

vi.mock('assistant-telegram-bot', () => ({
  getBot: () => bot,
  initBot: vi.fn(),
}));

function createMessage(text: string): TelegramMessage {
  return {
    chat: { id: 123 },
    text,
  } as TelegramMessage;
}

async function* createResponseStream(): AsyncGenerator<string> {
  yield THINK_START;
  yield 'internal reasoning';
  yield THINK_END;
  yield RESPONSE_ANCHOR;
  yield 'Visible reply';
}

describe('channels/telegram', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    bot.sendChatAction.mockResolvedValue(undefined);
    bot.sendMessage.mockResolvedValue(undefined);
  });

  it('removes think output before sending the Telegram reply', async () => {
    const agent: Parameters<typeof handleMessage>[0] = {
      handle: vi.fn().mockResolvedValue(createResponseStream()),
    };

    await handleMessage(agent, createMessage('hello'));

    expect(bot.sendChatAction).toHaveBeenCalledWith(123, 'typing');
    expect(bot.sendMessage).toHaveBeenCalledTimes(1);
    expect(bot.sendMessage).toHaveBeenCalledWith(123, 'Visible reply', {
      parse_mode: 'MarkdownV2',
    });
  });
});
