import { ILogger } from "../../infrastructure/logger";
import { escapeTelegramMarkdown, isAbortError } from "../../utils/telegram";
import { SkillsRepositoryFactory } from "../../repositories/skills";
import { PromptRepositoryFactory } from "../../repositories/prompt";
import { getAIProvider } from "../providers";
import { DatabaseServiceFactory } from "../../infrastructure/db-sqlite";
import { ProcessedMessage, ProcessOptions } from "../../types/agents";
import type { AIChatRequest, IMessageProvider } from "../../types/provider";
import type { Message } from "../../entities/message";

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
    const skillsRepository = SkillsRepositoryFactory.create(this.logger);
    const skills = skillsRepository.get();

    const db = DatabaseServiceFactory.create();
    const promptRepository = PromptRepositoryFactory.create(db);
    const messagesHistory = messageHistory?.map(m => ({ role: m.role, content: m.content }));
    const payload = promptRepository.build({
      userMessage: message,
      channel,
      skills,
      toolsEnabled: options?.toolsEnabled,
      messageHistory: messagesHistory,
    });

    this.logger.debug('AI request context', {
      messageHistory: messagesHistory ?? [],
      currentPrompt: message,
    });

    const chatRequest = payload as AIChatRequest;

    // Stream directly in TUI for the active AI provider
    if (channel === 'tui') {
      const thinkRequest: AIChatRequest = { ...chatRequest, think: true };
      const stream = provider.chatStream(thinkRequest, { signal: options?.signal });

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

class MessageProviderStreamFactory {
  static create(logger: ILogger): IMessageProvider {
    return new MessageProviderStream(logger);
  }
}

export { MessageProviderStreamFactory };
