import { extractToolCalls, normalizeResponse } from "../../utils/tool-calls";
import { TOOLS_RESULT_PROMPT } from "../../constants";
import { replacePlaceholders } from "../../utils/prompt";
import { MessageProviderFactory } from "../chat/message-provider";
import { IWorker } from "../../types/workers";
import { IMessageProvider } from "../../types/provider";
import { ILogger } from "../../infrastructure/logger";
import type { ToolCall } from "../../types/tools";
import type { LoopContext } from "../../types/context";
import type { ProcessedMessage } from "../../types/agents";
import type { Message } from "../../entities/message";

interface ExecutorWorkerArgs {
  toolCalls: ToolCall[];
  userMessage: string;
  messageHistory: Message[];
  ctx: LoopContext;
  iteration?: number;
  maxIterations?: number;
}

class ExecutorWorker implements IWorker {
  constructor(
    private logger: ILogger,
    public name: string,
    private messageProvider: IMessageProvider
  ) { }

  async run(args: ExecutorWorkerArgs): Promise<ProcessedMessage> {
    const { toolCalls, userMessage, messageHistory, ctx, iteration = 1, maxIterations = 10 } = args;

    if (iteration >= maxIterations) {
      this.logger.warn('Max tool iterations reached', {
        maxIterations,
        userMessage
      });
      return `Maximum tool execution iterations (${maxIterations})`+
        ` reached. Please try rephrasing your request.`;
    }
    ctx.onProgress(`Iteration ${iteration}`);

    this.logger.info(`Executing tools (${toolCalls})...`);

    const toolResultsArray = await ctx.toolsQueue.handle(
      toolCalls,
      ctx.signal
    );

    const toolResults = toolResultsArray
      .map((r) =>
        r.success
          ? `Tool: ${r.toolName}, Result: ${r.result}`
          : `Tool: ${r.toolName}, Success: ${r.success}, Error: ${r.error}`
      )
      .join('\n');
    this.logger.info(`Tool results: ${JSON.stringify(toolResults)}`);

    const synthesisPrompt = replacePlaceholders(TOOLS_RESULT_PROMPT, { v1: userMessage, v2: toolResults });
    const response = await this.messageProvider.handler(
      synthesisPrompt,
      ctx.channel,
      ctx.options,
      messageHistory
    );

    const normalizedResponse = normalizeResponse(response);
    const nextToolCalls = extractToolCalls(normalizedResponse, this.logger);

    if (nextToolCalls.length === 0) return normalizedResponse;

    this.logger.info(`Tool call (${nextToolCalls.length}) after execution phase: ${JSON.stringify(nextToolCalls)}`);

    return this.run({
      toolCalls: nextToolCalls,
      userMessage,
      messageHistory,
      ctx,
      iteration: iteration + 1,
      maxIterations,
    }
    );
  }
}

class ExecutorWorkerFactory {
  static create(logger: ILogger): IWorker {
    const messageProvider = MessageProviderFactory.create(logger);
    return new ExecutorWorker(logger, 'executorWorker', messageProvider);
  }
}

export { ExecutorWorkerFactory };