
import { extractToolCalls, normalizeResponse } from '../../../utils/tool-calls';
import { IToolsQueue, ToolsQueueFactory } from '../../tools-queue';
import { ExecutorWorkerFactory } from '../../workers/executor-worker';
import { LearnerWorkerFactory } from '../../workers/learner-worker';
import { FIRST_PROMPT_HELPER, SKILL_READY_PROMPT } from '../../../constants';
import { THINK_START, THINK_END, RESPONSE_ANCHOR } from '../../../constants/thinking';
import { replacePlaceholders } from '../../../utils/prompt';
import { MessageProviderStreamFactory } from '../../chat/message-provider-stream';
import type { ProcessedMessage, ProcessOptions } from '../../../types/agents';
import type { IMessageService } from '../../message-service';
import type { ILogger } from '../../../infrastructure/logger';
import type { Message } from '../../../entities/message';
import type { IMessageProvider } from '../../../types/provider';
import type { LoopContext } from '../../../types/context';
import type { ToolCall } from '../../../types/tools';
import type { IWorker } from '../../../types/workers';

interface ManagerArgs {
  userMessage: string;
  channel: string;
  message: IMessageService;
  options?: ProcessOptions;
}

interface IManager {
  name: string;
  run(args: ManagerArgs): Promise<ProcessedMessage>;
}

class Manager implements IManager {
  constructor(
    private logger: ILogger,
    public name: string,
    private toolsQueue: IToolsQueue,
    private messageProvider: IMessageProvider
  ) { }

  async run(args: ManagerArgs): Promise<ProcessedMessage> {
    const { userMessage, channel, message, options } = args;
    const messageHistory = message.getHistory();

    const ctx: LoopContext = {
      channel,
      message,
      toolsQueue: this.toolsQueue,
      signal: options?.signal ?? new AbortController().signal,
      onProgress: options?.onProgress ?? ((progress) => this.logger.info(progress)),
      options,
    };

    const prompt = replacePlaceholders(FIRST_PROMPT_HELPER, { v1: userMessage });
    const streamResult = await this.messageProvider.handler(prompt, channel, options, messageHistory);

    // Non-streaming path (Telegram, Web, non-Ollama).
    if (!this.isAsyncGen(streamResult)) {
      const responseText = normalizeResponse(streamResult);
      const callbacks = extractToolCalls(responseText);
      if (callbacks.length === 0) return responseText;
      return this.dispatchToolCalls(callbacks, userMessage, messageHistory, ctx);
    }

    // Streaming path (TUI+Ollama): stream thinking, detect and dispatch.
    return this.streamingDispatch(streamResult, userMessage, messageHistory, ctx);
  }

  /**
   * Shared tool-call dispatch: handles skill learning then tool execution.
   * Used by both the sync (non-TUI) and streaming (TUI) paths.
   * Returns a string result suitable for yielding or returning directly.
   */
  private async dispatchToolCalls(
    callbacks: ToolCall[],
    userMessage: string,
    messageHistory: Message[],
    ctx: LoopContext,
  ): Promise<ProcessedMessage> {
    const toLearn = callbacks.filter(cb => cb.name === 'get_skill');
    let toExecute = callbacks.filter(cb => cb.name !== 'get_skill');

    if (toLearn.length > 0) {
      const skillNames = toLearn.map(c => c.arguments.skill_name ?? c.arguments.name ?? c.name).join(', ');
      ctx.onProgress(`Learning phase: ${toLearn.length} skill(s) - ${skillNames}`);
      const learner = LearnerWorkerFactory.create(this.logger);
      await learner.run({ toolCalls: toLearn, userMessage, messageHistory, ctx });

      const skillPrompt = replacePlaceholders(SKILL_READY_PROMPT, { v1: userMessage });
      const aiResponse = await this.messageProvider.handler(skillPrompt, ctx.channel, ctx.options, ctx.message.getHistory());
      const responseText = await this.resolveToString(aiResponse);
      const allToolCalls = extractToolCalls(responseText);

      // Model answered directly from skill knowledge - no tool calls needed.
      if (allToolCalls.length === 0) return responseText;

      // Filter out any get_skill calls the model may have re-emitted after learning.
      toExecute = allToolCalls.filter(cb => cb.name !== 'get_skill');

      if (toExecute.length === 0) return responseText;
    }

    if (toExecute.length === 0) {
      ctx.onProgress('No tools to execute');
      return '';
    }

    ctx.onProgress(`Execution phase: ${toExecute.length} tool(s) - ${toExecute.map(c => c.name).join(' - ')}`);
    const executor = ExecutorWorkerFactory.create(this.logger);
    return executor.run({ toolCalls: toExecute, userMessage, messageHistory, ctx });
  }

  /**
   * Streaming dispatch: streams thinking in real-time while buffering content
   * to decide whether the model is answering directly (text) or using tools.
   */
  private async *streamingDispatch(
    gen: AsyncGenerator<string>,
    userMessage: string,
    messageHistory: Message[],
    ctx: LoopContext,
  ): AsyncGenerator<string> {
    let inThinking = false;
    let pastThinking = false;
    const contentBuffer: string[] = [];
    let streamingText = false;

    for await (const chunk of gen) {
      // Thinking phase: always yield immediately for real-time display.
      if (chunk === THINK_START) { inThinking = true; yield chunk; continue; }
      if (chunk === THINK_END)   { inThinking = false; pastThinking = true; yield chunk; continue; }
      if (inThinking) { yield chunk; continue; }

      // First content chunk without a prior thinking block.
      if (!pastThinking) pastThinking = true;

      // Text already decided: stream directly.
      if (streamingText) { yield chunk; continue; }

      contentBuffer.push(chunk);

      // Peek at accumulated content to decide text vs tool calls.
      const accumulated = contentBuffer.join('').trimStart();
      if (accumulated.length > 0 && !accumulated.startsWith('{')) {
        // Looks like prose - flush buffer and continue streaming.
        streamingText = true;
        for (const b of contentBuffer) yield b;
        contentBuffer.length = 0;
      }
    }

    // Stream finished.
    if (streamingText) return;

    // Buffered content might be tool calls.
    const fullContent = contentBuffer.join('');
    if (!fullContent.trim()) return;

    const callbacks = extractToolCalls(fullContent);
    if (callbacks.length === 0) {
      // Wasn't a tool call after all (e.g. text starting with '{') - yield as-is.
      yield* contentBuffer;
      return;
    }

    const result = await this.dispatchToolCalls(callbacks, userMessage, messageHistory, ctx);
    if (typeof result === 'string') {
      if (result.trim()) { yield RESPONSE_ANCHOR; yield result; }
      return;
    }
    if (this.isAsyncGen(result)) { yield RESPONSE_ANCHOR; yield* result; return; }
  }

  private isAsyncGen(val: unknown): val is AsyncGenerator<string> {
    return typeof val === 'object' && val !== null && Symbol.asyncIterator in val;
  }

  private async resolveToString(response: ProcessedMessage): Promise<string> {
    if (this.isAsyncGen(response)) {
      const chunks: string[] = [];
      let inThinking = false;
      for await (const chunk of response) {
        if (chunk === THINK_START) { inThinking = true; continue; }
        if (chunk === THINK_END)   { inThinking = false; continue; }
        if (inThinking) continue;
        if (chunk === RESPONSE_ANCHOR) continue;
        chunks.push(chunk);
      }
      return chunks.join('');
    }
    return normalizeResponse(response);
  }
}

class ManagerFactory {
  static create(logger: ILogger): IWorker {
    const messageProvider = MessageProviderStreamFactory.create(logger);
    const toolsQueue = ToolsQueueFactory.create(logger);
    return new Manager(logger, 'Manager', toolsQueue, messageProvider);
  }
}

export { IManager, Manager, ManagerFactory };
