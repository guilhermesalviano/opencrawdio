import type { ProcessOptions } from "../types/agents";
import type { IMessageService } from "../services/message-service";
import type { IToolsQueue } from "../services/tools-queue";

export interface LoopContext {
  channel: string;
  message: IMessageService;
  toolsQueue: IToolsQueue;
  signal: AbortSignal;
  onProgress: (msg: string) => void;
  options?: ProcessOptions;
}