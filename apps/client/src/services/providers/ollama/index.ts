import type { AIChatOptions, AIChatRequest, AIProvider } from '../../../types/provider';
import { config } from '../../../config'; 
import { ILogger } from '../../../infrastructure/logger';
import { validateBaseUrl } from '../../../utils/provider';
import { THINK_START, THINK_END } from '../../../constants/thinking';

type OllamaChatChunk = {
  message?: { 
    role?: string; 
    content?: string; 
    thinking?: string;
    tool_calls?: Array<{ function: { name: string; arguments: string } }>;
  };
  response?: string;
  done?: boolean;
  error?: string;
};

type OllamaVersionResponse = {
  version?: string;
};

class OllamaAIProvider implements AIProvider {
  readonly name = 'ollama';

  private readonly logger: ILogger;
  private readonly baseUrl: string;
  private readonly defaultModel: string;

  constructor(logger: ILogger, opts?: { baseUrl?: string; model?: string }) {
    this.logger = logger;
    const resolvedBaseUrl = (opts?.baseUrl ?? config.AI.BASE_URL).replace(/\/+$/, '');
    this.baseUrl = validateBaseUrl(resolvedBaseUrl, config.AI.ALLOW_REMOTE_BASE_URL);
    this.defaultModel = opts?.model    ?? config.AI.MODEL;
  }

  async chat(request: AIChatRequest, options?: AIChatOptions): Promise<string> {
    const controller = new AbortController();
    const unlinkAbort = this.linkAbortSignal(options?.signal, controller);

    const hardTimer = setTimeout(() => controller.abort(), config.AI.TIMEOUTS.HARD_MS);
    try {
      this.logger.debug('Ollama chat request', { 
        model: request.model ?? this.defaultModel,
        messagesCount: request.messages.length,
        hasTools: !!request.tools?.length,
      });
      
      const response = await this.readJsonFallback(request, controller.signal);
      this.logger.debug('Ollama chat raw response', { responseLength: response.length });
      this.logger.info("response: " + JSON.stringify(response))

      return response;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.logger.error('Ollama chat error', { error: errorMsg });
      
      if (this.isAbortError(err)) {
        if (options?.signal?.aborted) throw new Error('Ollama request aborted');
        throw new Error('Ollama request timed out during non-stream /api/chat request');
      }
      throw err;
    } finally {
      unlinkAbort();
      clearTimeout(hardTimer);
    }
  }

  // ollama.provider.ts — add chatStream, reuses existing private helpers

  async *chatStream(request: AIChatRequest, options?: AIChatOptions): AsyncGenerator<string> {
    const controller = new AbortController();
    const unlinkAbort = this.linkAbortSignal(options?.signal, controller);

    this.logger.info("Ollama chatStream initiated")

    let idleTimer: NodeJS.Timeout | undefined;
    const hardTimer = setTimeout(() => controller.abort(), config.AI.TIMEOUTS.HARD_MS);
    let totalChunksReceived = 0;
    let totalCharsYielded = 0;

    const bumpIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => controller.abort(), config.AI.TIMEOUTS.IDLE_MS);
    };

    bumpIdle();

    this.logger.debug('Ollama chatStream started', { 
      model: request.model ?? this.defaultModel,
      messagesCount: request.messages.length,
      hasTools: !!request.tools?.length,
    });

    try {
      const body = await this.fetchStream(request, controller.signal);
      this.logger.info("body from chatStream response: " + JSON.stringify(body))

      if (!body) {
        this.logger.debug('Ollama stream body is null, falling back to JSON');
        const full = await this.readJsonFallback(request, controller.signal);
        totalCharsYielded = full.length;
        yield full;
        return;
      }

      let streamInThinking = false;
      let jsonBuffer = '';

      for await (const chunk of this.readNDJSON(body, bumpIdle)) {
        totalChunksReceived++;
        if (chunk.error) {
          this.logger.error('Ollama stream error chunk', { error: chunk.error });
          throw new Error(chunk.error);
        }

        const chunkHasThinking = !!(chunk.message?.thinking && !chunk.message?.content && !chunk.response);

        if (chunkHasThinking && !streamInThinking) {
          streamInThinking = true;
          yield THINK_START;
        } else if (!chunkHasThinking && streamInThinking) {
          streamInThinking = false;
          yield THINK_END;
        }

        // Yield thinking content immediately — never buffer it.
        if (chunkHasThinking) {
          const text = this.parseChunk(chunk);
          if (text) { totalCharsYielded += text.length; yield text; }
          continue;
        }

        if (chunk.done) {
          if (streamInThinking) yield THINK_END;

          if (chunk.message?.tool_calls && chunk.message.tool_calls.length > 0) {
            // Tool call response: yield only the clean parsed JSON, discarding
            // the raw JSON fragments that were streamed in intermediate chunks.
            const toolCallJson = JSON.stringify({ tool_calls: chunk.message.tool_calls });
            totalCharsYielded += toolCallJson.length;
            yield toolCallJson;
          } else if (jsonBuffer) {
            // Content looked like JSON but was actually prose — flush it.
            const finalText = this.parseChunk(chunk);
            const full = jsonBuffer + (finalText ?? '');
            totalCharsYielded += full.length;
            yield full;
          } else {
            const text = this.parseChunk(chunk);
            if (text) { totalCharsYielded += text.length; yield text; }
          }

          this.logger.debug('Ollama stream completed', { chunksReceived: totalChunksReceived });
          break;
        }

        // Non-done, non-thinking chunk: buffer if it looks like JSON being built.
        const text = this.parseChunk(chunk);
        if (text) {
          if (jsonBuffer || text.trimStart().startsWith('{')) {
            jsonBuffer += text;
          } else {
            totalCharsYielded += text.length;
            yield text;
          }
        }
      }

      this.logger.info('Ollama chatStream response complete', {
        model: request.model ?? this.defaultModel,
        chunksReceived: totalChunksReceived,
        charsYielded: totalCharsYielded,
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.logger.error('Ollama chatStream error', { 
        error: errorMsg,
        chunksReceived: totalChunksReceived,
        charsYielded: totalCharsYielded,
      });

      if (this.isAbortError(err)) {
        if (options?.signal?.aborted) throw new Error('Ollama request aborted');
        throw new Error('Ollama request timed out while streaming');
      }
      throw err;
    } finally {
      unlinkAbort();
      clearTimeout(idleTimer);
      clearTimeout(hardTimer);
    }
  }

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.AI.TIMEOUTS.HEALTH_MS);

    try {
      const res = await fetch(`${this.baseUrl}/api/version`, {
        signal: controller.signal,
      });

      if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };

      const data = (await res.json()) as OllamaVersionResponse;
      return { ok: true, detail: data.version ? `v${data.version}` : 'ok' };
    } catch (err) {
      return {
        ok: false,
        detail: err instanceof Error ? err.message : 'unknown error',
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private async fetchStream(
    request: AIChatRequest,
    signal: AbortSignal,
  ): Promise<ReadableStream<Uint8Array> | null> {
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method : 'POST',
      headers: { 'content-type': 'application/json' },
      body   : JSON.stringify({
        model      : request.model ?? this.defaultModel,
        messages   : request.messages,
        tools      : request.tools,
        stream     : true,
        ...(request.think ? { think: true } : {}),
        temperature: request.temperature,
      }),
      signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Ollama /api/chat failed (${res.status}): ${text}`);
    }

    return res.body ?? null;
  }

  /** Fallback for proxies / servers that ignore stream:true */
  private async readJsonFallback(
    request: AIChatRequest,
    signal: AbortSignal,
  ): Promise<string> {
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method : 'POST',
      headers: { 'content-type': 'application/json' },
      body   : JSON.stringify({
        model      : request.model ?? this.defaultModel,
        messages   : request.messages,
        tools      : request.tools,
        stream     : false,
        temperature: request.temperature,
      }),
      signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Ollama /api/chat (non-stream) failed (${res.status}): ${text}`);
    }

    const data = (await res.json()) as OllamaChatChunk;
    
    // Handle tool calls (model response with tool_calls but no content)
    if (data.message?.tool_calls && (!data.message?.content || data.message.content.trim() === '')) {
      this.logger.debug('Tool calls detected in non-stream response', { toolCallsCount: data.message.tool_calls.length });
      // Return JSON representation of tool calls
      return JSON.stringify({ tool_calls: data.message.tool_calls });
    }
    
    const content = this.parseChunk(data);
    if (!content) throw new Error('Ollama response missing content');
    return content;
  }

  /**
   * Async generator that reads NDJSON from a streaming response body.
   * Calls onBump() on every received chunk to reset the idle timeout.
   *
   * Streaming fix: the TextDecoder must be flushed *before* we stop
   * reading, not after — so we call decoder.decode(value, { stream: true })
   * on every chunk including the last one, then flush with decoder.decode()
   * only once the reader signals done.
   */
  private async *readNDJSON(
    body: ReadableStream<Uint8Array>,
    onBump: () => void,
  ): AsyncGenerator<OllamaChatChunk> {
    const reader  = body.getReader();
    const decoder = new TextDecoder();
    let   buffer  = '';

    try {
      while (true) {
        const { value, done } = await reader.read();

        // Flush decoder: always decode with stream=!done so the internal
        // buffer drains correctly on the very last read.
        const text = decoder.decode(value ?? new Uint8Array(), { stream: !done });

        if (text) {
          onBump();
          buffer += text;

          // Yield every complete line
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';  // keep incomplete tail

          for (const line of lines) {
            const parsed = this.parseLine(line);
            if (parsed) yield parsed;
          }
        }

        if (done) break;
      }

      // Flush any remaining bytes left in the buffer after EOF
      if (buffer.trim()) {
        const parsed = this.parseLine(buffer);
        if (parsed) yield parsed;
      }
    } finally {
      reader.releaseLock();
    }
  }

  private parseLine(line: string): OllamaChatChunk | null {
    const trimmed = line.trim();
    if (!trimmed) return null;

    try {
      return JSON.parse(trimmed) as OllamaChatChunk;
    } catch {
      return null;   // malformed line — skip silently
    }
  }

  private parseChunk(chunk: OllamaChatChunk): string {
    // Handle tool calls in response (prioritize over content)
    if (chunk.message?.tool_calls && chunk.message.tool_calls.length > 0) {
      return JSON.stringify({ tool_calls: chunk.message.tool_calls });
    }
    // When thinking is present but content is empty, this is a thinking-only chunk.
    // The thinking text is handled via THINK_START/THINK_END sentinels; return it only
    // so the sentinel accumulator in chatStream can yield it inside the thinking block.
    // For mixed chunks (thinking + content), prefer content.
    if (chunk.message?.thinking && !chunk.message?.content) {
      return chunk.message.thinking;
    }
    return chunk.message?.content || chunk.response || '';
  }

  private isAbortError(err: unknown): boolean {
    return (
      err instanceof Error &&
      (err.name === 'AbortError' || /aborted/i.test(err.message))
    );
  }

  private linkAbortSignal(signal: AbortSignal | undefined, controller: AbortController): () => void {
    if (!signal) return () => undefined;
    if (signal.aborted) {
      controller.abort(signal.reason);
      return () => undefined;
    }

    const onAbort = () => controller.abort(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    return () => signal.removeEventListener('abort', onAbort);
  }
}

class OllamaAIProviderFactory {
  static create(logger: ILogger): AIProvider {
    return new OllamaAIProvider(logger);
  }
}

export { OllamaAIProvider, OllamaAIProviderFactory };