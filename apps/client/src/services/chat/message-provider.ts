import { getAIProvider } from "../providers";
import { escapeTelegramMarkdown, isAbortError } from "../../utils/telegram";
import { ILogger } from "../../infrastructure/logger";
import { SkillsRepositoryFactory } from "../../repositories/skills";
import type { AIChatRequest, IMessageProvider } from "../../types/provider";
import { PromptRepositoryFactory } from "../../repositories/prompt";
import type { Message } from "../../entities/message";
import { ProcessedMessage, ProcessOptions } from "../../types/agents";
import { DatabaseServiceFactory } from "../../infrastructure/db-sqlite";

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
    const skillsRepository = SkillsRepositoryFactory.create(this.logger);
    const skills = skillsRepository.get();

    /**
     * Todo:
     * passa prompt repository as dependency
     */
    const db = DatabaseServiceFactory.create();
    const promptRepository = PromptRepositoryFactory.create(db);
    
    const messagesHistory = messageHistory?.map(m => ({ role: m.role, content: m.content }));

    // to fix: probaly, assistant messages is not saving im this prompt build... Its not good.
    const payload = promptRepository.build({ 
      userMessage: message, 
      channel, 
      skills, 
      toolsEnabled: options?.toolsEnabled,
      messageHistory: messagesHistory
    });
    
    this.logger.debug('AI request context', {
      messageHistory: messagesHistory ?? [],
      currentPrompt: message,
    });

    const chatRequest = payload as AIChatRequest;

    try {
      return await provider.chat(chatRequest, { signal: options?.signal });
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
