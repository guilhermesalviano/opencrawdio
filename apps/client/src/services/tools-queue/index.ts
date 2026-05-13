import pLimit from "p-limit";
import { AgnosticExecutionToolFactory, IAgnosticExecutionTool } from "../tools";
import type { ILogger } from "../../infrastructure/logger";
import type { ToolCall, ToolResult } from "../../types/tools";

interface IToolsQueue {
  handle(
    tools: ToolCall[],
    signal: AbortSignal,
  ): Promise<ToolResult[]>;
}

class ToolsQueue implements IToolsQueue {
  constructor(
    private logger: ILogger,
    private agnosticExecutionTool: IAgnosticExecutionTool,
    private maxWorkers: number = 2
  ) { }

  async handle(
    tools: ToolCall[],
    signal: AbortSignal,
  ): Promise<ToolResult[]> {
    const limit = pLimit(this.maxWorkers);

    const promises = tools.map((tool) =>
      limit(async () => {
        if (signal.aborted) {
          throw new Error('Tool execution aborted');
        }

        try {
          return await this.agnosticExecutionTool.handle(this.logger, tool);
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          this.logger.error('Tool execution failed', { toolName: tool.name, error: errorMsg });
          return {
            toolName: tool.name,
            success: false,
            error: errorMsg,
          } as ToolResult;
        }
      })
    );

    const results = await Promise.all(promises);

    this.logger.info('Tools completed', { count: results.length });

    return results;
  }
}

class ToolsQueueFactory {
  static create(logger: ILogger, maxWorkers: number = 2): ToolsQueue {
    const agnosticExecutionTool = AgnosticExecutionToolFactory.create();
    return new ToolsQueue(logger, agnosticExecutionTool, maxWorkers);
  }
}

export { IToolsQueue, ToolsQueue, ToolsQueueFactory };
