import { IContextRepository, ContextRepositoryFactory } from './context';
import type { AIChatRequest, AIToolDefinition } from '../types/provider';
import { IToolsRepository, ToolsRepositoryFactory } from './tools';
import { Message, MessageRole } from '../types/messages';
import { ILearnedSkillsRepository, LearnedSkillsRepositoryFactory } from './learned-skills';
import { IMemoryRepository, MemoryRepositoryFactory } from './memory';
import { IDatabaseService } from '../infrastructure/db-sqlite';
import { SYSTEM_PROMPT } from '../constants';
import { SkillsRepositoryFactory } from './skills';
import { ILogger } from '../infrastructure/logger';

const DEFAULT_LEARNED_SKILLS_LIMIT = 10;

interface BuildPromptParams {
  userMessage: string;
  channel: string;
  toolsEnabled?: boolean;
  messageHistory?: Message[];
  includeTaskTools?: boolean;
}

interface IPromptRepository {
  build(params: BuildPromptParams): AIChatRequest;
}

/**
 * Repository for building and managing AI prompts.
 * Composes system prompts, user messages, and tool definitions.
 */
class PromptRepository implements IPromptRepository {
  constructor(
    private contextRepository: IContextRepository,
    private toolsRepository: IToolsRepository,
    private learnedSkillsRepository: ILearnedSkillsRepository,
    private memoryRepository: IMemoryRepository,
  ) {}

  /**
   * Used to build the prompt. But can also be used to rebuild prompts with updated config, context and history.
   * @param params BuildPromptParams
   * @returns AIChatRequest
   */
  build(params: BuildPromptParams): AIChatRequest {
    const messages = this.buildHistory(params);
    const tools = this.buildTools(params);

    return { messages, tools };
  }

  /**
   * Build all messages (system + history + user)
   */
  private buildHistory({ channel, userMessage, messageHistory }: BuildPromptParams): Message[] {
    return [
      ...this.buildSystemPrompt(channel),
      ...(messageHistory || []),
      this.buildMessage("user", userMessage),
    ];
  }

  /**
   * Build system prompt messages
   */
  private buildSystemPrompt(channel: string): Message[] {
    const messages: Message[] = [];
    const baseHistory = this.buildBaseHistoryPrompt(SYSTEM_PROMPT);

    // TODO: get only old and relevant memories instead of all. Exclude actual session.
    const memory = this.buildMemoryContext();
    let systemInstructions = memory ? `
      ${baseHistory}\n Persistent context from other sessions: ${memory}` : baseHistory;

    const context = this.contextRepository.get({ channel });
    if (context) systemInstructions += `\n ${context}`;

    messages.push({ role: 'system', content: systemInstructions });

    return messages;
  }

  private buildMemoryContext(): string {
    const memories = this.memoryRepository.getAll().map(m => `${m.type}: ${m.content}`).join('\n');
    return memories.slice(0, 15000);
  }

  private buildBaseHistoryPrompt(basePrompt: string): string {
    const learnedSkillsLimit = DEFAULT_LEARNED_SKILLS_LIMIT;
    const learnedSkillsContent = this.learnedSkillsRepository
      .getRecent(learnedSkillsLimit)
      .map(skill => skill.skill_content?.trim())
      .filter((content): content is string => Boolean(content))
      .join('\n')
      .slice(0, 15000);

    if (!learnedSkillsContent) return basePrompt;

    return `${basePrompt}\n${learnedSkillsContent}`;
  }

  private buildTools({ toolsEnabled, includeTaskTools }: BuildPromptParams): AIToolDefinition[] | undefined {
    const toolsEnabledFinal = toolsEnabled ?? true;
    
    if (!toolsEnabledFinal) {
      return undefined;
    }

    return this.toolsRepository.getAll({
      includeTaskTools,
    });
  }

  private buildMessage(role: MessageRole, content: string): Message {
    return { role, content };
  }
}

class PromptRepositoryFactory {
  static create(db: IDatabaseService, logger: ILogger): PromptRepository {
    const contextRepository = ContextRepositoryFactory.create();
    const skillsRepository = SkillsRepositoryFactory.create(logger);
    const toolsRepository = ToolsRepositoryFactory.create(skillsRepository.get());
    const learnedSkillsRepository = LearnedSkillsRepositoryFactory.create(db);
    const memoryRepository = MemoryRepositoryFactory.create(db);
    return new PromptRepository(contextRepository, toolsRepository, learnedSkillsRepository, memoryRepository);
  }
}

export { IPromptRepository, PromptRepository, PromptRepositoryFactory };
