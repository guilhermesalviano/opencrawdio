import type { AIChatOptions, AIChatRequest, AIProvider } from '../../../types/provider';
import { config } from '../../../config';
import { ILogger } from '../../../infrastructure/logger';
import { validateBaseUrl } from '../../../utils/provider';
import { THINK_START, THINK_END } from '../../../constants/thinking';

type OllamaChatChunk = {
  message?: {
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
  private readonly baseUrl: string;
  private readonly defaultModel: string;

  constructor(private readonly logger: ILogger, opts?: { baseUrl?: string; model?: string }) {
    const resolvedBaseUrl = (opts?.baseUrl ?? config.AI.BASE_URL).replace(/\/+$/, '');
    this.baseUrl = validateBaseUrl(resolvedBaseUrl, config.AI.ALLOW_REMOTE_BASE_URL);
    this.defaultModel = opts?.model ?? config.AI.MODEL;
  }

  async chat(request: AIChatRequest, options?: AIChatOptions): Promise<string> {
    const { controller, cleanup } = this.makeController(options?.signal);
    try {
      this.logger.debug('Ollama chat request', {
        model: request.model ?? this.defaultModel,
        messagesCount: request.messages.length,
        hasTools: !!request.tools?.length,
      });

      return await this.postChat(request, controller.signal);
    } catch (err) {
      this.logger.error('Ollama chat error', { error: err instanceof Error ? err.message : String(err) });
      if (this.isAbortError(err)) {
        throw new Error(options?.signal?.aborted ? 'Ollama request aborted' : 'Ollama request timed out during non-stream /api/chat request');
      }
      throw err;
    } finally {
      cleanup();
    }
  }

  async *chatStream(request: AIChatRequest, options?: AIChatOptions): AsyncGenerator<string> {
    const { controller, cleanup } = this.makeController(options?.signal);

    let idleTimer: NodeJS.Timeout | undefined;
    const bumpIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => controller.abort(), config.AI.TIMEOUTS.IDLE_MS);
    };

    let totalChunksReceived = 0;
    let totalCharsYielded = 0;

    this.logger.debug('Ollama chatStream started', {
      model: request.model ?? this.defaultModel,
      messagesCount: request.messages.length,
      hasTools: !!request.tools?.length,
    });

    try {
      const res = await this.post(request, controller.signal, true);
      const body = res.body;

      if (!body) {
        this.logger.debug('Ollama stream body is null, falling back to non-stream');
        const full = await this.postChat(request, controller.signal);
        totalCharsYielded = full.length;
        yield full;
        return;
      }

      let streamInThinking = false;
      let jsonBuffer = '';
      let producedAnswer = false;

      bumpIdle();
      for await (const chunk of this.readNDJSON(body, bumpIdle)) {
        totalChunksReceived++;
        if (chunk.error) throw new Error(chunk.error);

        const isThinking = !!(chunk.message?.thinking && !chunk.message?.content && !chunk.response);

        if (isThinking && !streamInThinking) {
          streamInThinking = true;
          yield THINK_START;
        } else if (!isThinking && streamInThinking) {
          streamInThinking = false;
          yield THINK_END;
        }

        if (isThinking) {
          const text = this.parseChunk(chunk);
          if (text) {
            totalCharsYielded += text.length;
            yield text;
          }
          continue;
        }

        if (chunk.done) {
          if (streamInThinking) yield THINK_END;

          if (chunk.message?.tool_calls?.length) {
            const toolCallJson = JSON.stringify({ tool_calls: chunk.message.tool_calls });
            producedAnswer = true;
            totalCharsYielded += toolCallJson.length;
            yield toolCallJson;
          } else if (jsonBuffer) {
            const full = jsonBuffer + (this.parseChunk(chunk) ?? '');
            producedAnswer = true;
            totalCharsYielded += full.length;
            yield full;
          } else {
            const text = this.parseChunk(chunk);
            if (text) {
              producedAnswer = true;
              totalCharsYielded += text.length;
              yield text;
            }
          }
          break;
        }

        const text = this.parseChunk(chunk);
        if (text) {
          if (jsonBuffer || text.trimStart().startsWith('{')) {
            jsonBuffer += text;
          } else {
            producedAnswer = true;
            totalCharsYielded += text.length;
            yield text;
          }
        }
      }

      if (streamInThinking) {
        yield THINK_END;
      }

      if (!producedAnswer) {
        this.logger.debug('No answer parsed from stream, retrying in non-stream mode');
        const full = await this.postChat(request, controller.signal);
        if (full) {
          totalCharsYielded += full.length;
          yield full;
        }
      }

      this.logger.info('Ollama chatStream complete', {
        model: request.model ?? this.defaultModel,
        chunksReceived: totalChunksReceived,
        charsYielded: totalCharsYielded,
      });
    } catch (err) {
      this.logger.error('Ollama chatStream error', {
        error: err instanceof Error ? err.message : String(err),
        chunksReceived: totalChunksReceived,
        charsYielded: totalCharsYielded,
      });

      if (this.isAbortError(err)) {
        if (options?.signal?.aborted) throw new Error('Ollama request aborted');
        throw new Error('Ollama request timed out while streaming');
      }
      throw err;
    } finally {
      clearTimeout(idleTimer);
      cleanup();
    }
  }

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.AI.TIMEOUTS.HEALTH_MS);
    try {
      const res = await fetch(`${this.baseUrl}/api/version`, { signal: controller.signal });
      if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };

      const data = await res.json() as OllamaVersionResponse;
      return { ok: true, detail: data.version ? `v${data.version}` : 'ok' };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : 'unknown error' };
    } finally {
      clearTimeout(timer);
    }
  }

  private async postChat(request: AIChatRequest, signal: AbortSignal): Promise<string> {
    const res = await this.post(request, signal, false);
    const data = await res.json() as OllamaChatChunk;

    if (data.message?.tool_calls?.length && !data.message?.content?.trim()) {
      this.logger.debug('Tool calls in non-stream response', { count: data.message.tool_calls.length });
      return JSON.stringify({ tool_calls: data.message.tool_calls });
    }

    const content = this.parseChunk(data);
    if (!content) throw new Error('Ollama response missing content');
    return content;
  }

  private makeController(outerSignal?: AbortSignal): { controller: AbortController; cleanup: () => void } {
    const controller = new AbortController();
    const hardTimer = setTimeout(() => controller.abort(), config.AI.TIMEOUTS.HARD_MS);

    if (!outerSignal) return { controller, cleanup: () => clearTimeout(hardTimer) };
    if (outerSignal.aborted) {
      controller.abort(outerSignal.reason);
      return { controller, cleanup: () => clearTimeout(hardTimer) };
    }

    const onAbort = () => controller.abort(outerSignal.reason);
    outerSignal.addEventListener('abort', onAbort, { once: true });
    return {
      controller,
      cleanup: () => {
        clearTimeout(hardTimer);
        outerSignal.removeEventListener('abort', onAbort);
      },
    };
  }

  private async *readNDJSON(
    body: ReadableStream<Uint8Array>,
    onBump: () => void,
  ): AsyncGenerator<OllamaChatChunk> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const { value, done } = await reader.read();
        const text = decoder.decode(value ?? new Uint8Array(), { stream: !done });
        if (text) {
          onBump();
          buffer += text;
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            const parsed = this.parseLine(line);
            if (parsed) yield parsed;
          }
        }
        if (done) break;
      }

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

    const maybeSSE = trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed;
    if (!maybeSSE || maybeSSE === '[DONE]') return null;

    try {
      return JSON.parse(maybeSSE) as OllamaChatChunk;
    } catch {
      return null;
    }
  }

  private parseChunk(chunk: OllamaChatChunk): string {
    if (chunk.message?.tool_calls?.length) return JSON.stringify({ tool_calls: chunk.message.tool_calls });
    if (chunk.message?.thinking && !chunk.message?.content) return chunk.message.thinking;
    return chunk.message?.content || chunk.response || '';
  }

  private isAbortError(err: unknown): boolean {
    return err instanceof Error && (err.name === 'AbortError' || /aborted/i.test(err.message));
  }

  private async post(request: AIChatRequest, signal: AbortSignal, stream: boolean): Promise<Response> {

    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: request.model ?? this.defaultModel,
        messages: request.messages,
        tools: request.tools,
        keep_alive: '15m',
        options: {
          num_ctx: 32768
        },
        stream
      }),
      signal,
    });

    this.logger.debug('Ollama /api/chat response', { status: res.status, stream, url: `${this.baseUrl}/api/chat` });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Ollama /api/chat failed (${res.status}): ${text}`);
    }

    return res;
  }
}

class OllamaAIProviderFactory {
  static create(logger: ILogger): AIProvider {
    return new OllamaAIProvider(logger);
  }
}

export { OllamaAIProvider, OllamaAIProviderFactory };
