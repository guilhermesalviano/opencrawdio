import { ILogger } from "../../infrastructure/logger";
import { escapeTelegramMarkdown, isAbortError } from "../../utils/telegram";
import { PromptRepositoryFactory } from "../../repositories/prompt";
import { getAIProvider } from "../providers";
import { DatabaseServiceFactory } from "../../infrastructure/db-sqlite";
import { ProcessedMessage, ProcessOptions } from "../../types/agents";
import type { IMessageProvider } from "../../types/provider";
import type { Message } from "../../entities/message";

const SUPPORTED_STREAM = ['tui', 'web'];

class MessageProviderStream implements IMessageProvider {
  constructor(
    private logger: ILogger,
  ) { }

  async handler(
    message: string,
    channel: string,
    options?: ProcessOptions,
    messageHistory?: Message[]
  ): Promise<ProcessedMessage> {
    const provider = getAIProvider(this.logger);

    const db = DatabaseServiceFactory.create();
    const promptRepository = PromptRepositoryFactory.create(db, this.logger);
    const messagesHistory = messageHistory?.map(m => ({ role: m.role, content: m.content }));
    const promptPayload = promptRepository.build({
      userMessage: message,
      channel,
      toolsEnabled: options?.toolsEnabled,
      messageHistory: messagesHistory,
    });

    this.logger.debug('THE PROMPT PAYLOAD', {
      promptPayload,
    });

    if (SUPPORTED_STREAM.includes(channel)) {
      const stream = provider.chatStream(promptPayload, { signal: options?.signal });

      async function* safeStream(): AsyncGenerator<string> {
        try {
          for await (const chunk of stream) {
            if (options?.signal?.aborted) return;
            yield chunk;
          }
        } catch (err) {
          if (options?.signal?.aborted || isAbortError(err)) return;
          const detail = err instanceof Error ? err.message : String(err);
          yield `\n(AI provider error: ${detail})`;
        }
      }

      return safeStream();
    }

    try {
      return await provider.chat(promptPayload, { signal: options?.signal });
    } catch (err) {
      if (options?.signal?.aborted || isAbortError(err)) {
        throw err;
      }
      const detail = err instanceof Error ? err.message : String(err);
      return channel === 'telegram'
        ? `I received your message: "${escapeTelegramMarkdown(message)}"\n\n(AI provider error: ${escapeTelegramMarkdown(detail)})`
        : `I received your message: "${message}"\n\n(AI provider error: ${detail})`;
    }
  }
}

class MessageProviderStreamFactory {
  static create(logger: ILogger): IMessageProvider {
    return new MessageProviderStream(logger);
  }
}

export { MessageProviderStreamFactory };
