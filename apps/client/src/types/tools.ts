import type { ILogger } from "../infrastructure/logger";

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  toolName: string;
  success: boolean;
  result?: string;
  error?: string;
}

export type CommandFn = (logger: ILogger, args: Record<string, unknown>) => Promise<ToolResult>;

export interface AIAgentRequest {
  model?: string;
}
