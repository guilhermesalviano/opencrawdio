import { getAIProvider } from "../providers";
import { escapeTelegramMarkdown, isAbortError } from "../../utils/telegram";
import { ILogger } from "../../infrastructure/logger";
import { PromptRepositoryFactory } from "../../repositories/prompt";
import { ProcessedMessage, ProcessOptions } from "../../types/agents";
import { DatabaseServiceFactory } from "../../infrastructure/db-sqlite";
import type { IMessageProvider } from "../../types/provider";
import type { Message } from "../../entities/message";

class MessageProvider implements IMessageProvider {
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

    /**
     * Todo:
     * passa prompt repository as dependency
     */
    const db = DatabaseServiceFactory.create();
    const promptRepository = PromptRepositoryFactory.create(db, this.logger);
    
    const messagesHistory = messageHistory?.map(m => ({ role: m.role, content: m.content }));

    // to fix: probaly, assistant messages is not saving im this prompt build... Its not good.
    const promptPayload = promptRepository.build({ 
      userMessage: message,
      channel,
      toolsEnabled: options?.toolsEnabled,
      messageHistory: messagesHistory
    });
    
    this.logger.debug('THE PROMPT PAYLOAD', {
      promptPayload,
    });

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

class MessageProviderFactory {
  static create(logger: ILogger): IMessageProvider {
    return new MessageProvider(logger);
  }
}

export { MessageProviderFactory };
