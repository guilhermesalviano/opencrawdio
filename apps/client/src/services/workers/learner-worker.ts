import { ILearnedSkillsRepository, LearnedSkillsRepositoryFactory } from "../../repositories/learned-skills";
import { DatabaseServiceFactory } from "../../infrastructure/db-sqlite";
import { config } from "../../config";
import { SKILL_LEARNING_PROMPT } from "../../constants";
import { replacePlaceholders } from "../../utils/prompt";
import type { LoopContext } from "../../types/context";
import type { ToolCall } from "../../types/tools";
import type { Message } from "../../entities/message";
import { IWorker } from "../../types/workers";
import { ILogger } from "../../infrastructure/logger";

interface LearnerWorkerArgs {
  toolCalls: ToolCall[];
  userMessage: string;
  messageHistory: Message[];
  ctx: LoopContext;
  iteration?: number;
  maxIterations?: number;
}

class LearnerWorker implements IWorker {
  constructor(
    private logger: ILogger,
    public name: string = 'learnerWorker',
    private skillsRepo: ILearnedSkillsRepository
  ) { }


  async run(
    args: LearnerWorkerArgs
  ): Promise<boolean> {
    const { toolCalls, ctx } = args;
    

    if (toolCalls.length === 0) return false;

    for (const toolCall of toolCalls) {
      const skillName = (toolCall.arguments.name ?? toolCall.arguments.skill_name) as string;
      if (!skillName || typeof skillName !== 'string') {
        this.logger.warn(`Skipping tool call with missing skill_name`, { toolCall });
        continue;
      }

      const skillResults = await ctx.toolsQueue.handle(
        [ toolCall ],
        ctx.signal
      );
      const skillContent = skillResults
        .map((r) => r.success ? r.result ?? '' : r.error ?? '')
        .join('\n')
        .replace(/<GMAIL_GATEWAY_HOST>/g, config.GMAIL.GATEWAY_HOST);

      try {
        const learningPrompt = replacePlaceholders(
          SKILL_LEARNING_PROMPT,
          { v1: skillName, v2: skillContent }
        );

        if (!this.skillsRepo.exists(skillName as string)) {
          this.skillsRepo.save({ skill_name: skillName, skill_content: learningPrompt });
          this.logger.info(`✓ Skill "${skillName}" learned and saved to database`);
          continue;
        }
        this.logger.warn(`- Skill "${skillName}" learned but already exists in database, skipping save`);
      } catch (error) {
        this.logger.error('Failed to save learned skill', { skillName, error });
        ctx.onProgress(`⚠ Skill "${skillName}" learned but failed to save to database`);
        return false;
      }
    }
    return true;
  }
}

class LearnerWorkerFactory {
  static create(logger: ILogger): IWorker {
    const db = DatabaseServiceFactory.create();
    const skillsRepo = LearnedSkillsRepositoryFactory.create(db);
    return new LearnerWorker(logger, 'learnerWorker', skillsRepo);
  }
}

export { LearnerWorkerFactory };