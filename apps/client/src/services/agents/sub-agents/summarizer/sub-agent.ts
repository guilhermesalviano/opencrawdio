import { IMemoryService } from "../../../memory-service";
import type { ILogger } from "../../../../infrastructure/logger";
import { getAIProvider } from "../../../providers";
import { MemoryType } from "../../../../types/memory";
import { SUMMARIZATION_PROMPT } from "../../../../constants";
import { replacePlaceholders } from "../../../../utils/prompt";
import { beginFooterActivity } from "../../../../utils/footer-activity";
import { ISubAgent } from "../../../../types/agents";

interface SummarizerWorkerProps {
  sessionId: string,
  ask: string,
  answer: string,
  type: MemoryType,
  channel: string,
  memoryService: IMemoryService,
}

class Summarizer implements ISubAgent {
  constructor(
    private logger: ILogger,
  ) { }

  async handler(
    props: SummarizerWorkerProps
  ): Promise<void> {
    const endFooterActivity = beginFooterActivity('summarizer');
    this.logger.info(`Summarizer worker started for session ${props.sessionId} in ${props.channel}`);
    const provider = getAIProvider(this.logger);

    const prompt = replacePlaceholders(SUMMARIZATION_PROMPT, { v1: props.ask, v2: props.answer });

    try {
      const content = await provider
        .chat({ messages: [{ role: "user", content: prompt }] });

      const memory = {
        type: props.type,
        content,
      };

      props.memoryService.upsert(memory);
      this.logger.info(`Summarizer worker completed for session ${props.sessionId}`);
    } catch (error) {
      this.logger.error(`Failed to summarize for session ${props.sessionId}`, { error });
    } finally {
      endFooterActivity();
    }
  }
}

class SummarizerFactory {
  static create(logger: ILogger) {
    return new Summarizer(logger);
  }
}

export { Summarizer, SummarizerFactory };
