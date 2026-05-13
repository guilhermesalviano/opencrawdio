# koris-agent Agent System

**AI Coding Assistants**: Authoritative architecture reference for the `koris-agent` monorepo. Read this before making changes.

---

## Monorepo Overview

| Package | Path | Description |
|---|---|---|
| `koris-agent` | `apps/client/` | Main runnable app — Telegram + TUI + Web channels |
| `assistant-tui` | `apps/assistant-tui/` | Reusable readline-based TUI runner (CJS lib) |
| `assistant-telegram-bot` | `apps/telegram-bot/` | Dependency-free Telegram polling bot module (CJS lib) |
| `sh-compression` | `apps/sh-compression/` | CLI proxy + sub-instruction parsing helpers (CJS lib + `sh-compression` bin) |

**Requires**: Node ≥ 24, pnpm 10.18.3

### Root Scripts

| Script | Command |
|---|---|
| `pnpm build` | `turbo run build` — builds all packages in dependency order |
| `pnpm lint` | `turbo run lint` — TypeScript type-check across all packages |
| `pnpm test` | `turbo run test` |
| `pnpm test:coverage` | Vitest v8 coverage |
| `pnpm test:mutation` | Stryker mutation testing |
| `pnpm dev` | Starts `apps/client` in Telegram + Web mode (`tsx` watch) |
| `pnpm dev:tui` | Starts `apps/client` in TUI mode |
| `pnpm start` / `pnpm start:tui` | Runs compiled `dist/src/app.js` |

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                        User Interfaces                       │
├─────────────────┬──────────────────┬─────────────────────────┤
│   TUI           │   Web (Express)  │   Telegram Bot          │
│ channels/tui/   │  channels/web/   │  channels/telegram/     │
└────────┬────────┴────────┬─────────┴──────────┬──────────────┘
         │                 │                     │
         └─────────────────┼─────────────────────┘
                           ▼
             ┌─────────────────────────┐
             │    AgentHandler         │
             │  services/agents/       │
             │    handler.ts           │
             └──────────┬──────────────┘
                        │
           ┌────────────┴────────────┐
           ▼                         ▼
   ┌──────────────┐        ┌─────────────────┐
   │  Commands    │        │   manager()     │
   │ commands/    │        │   tools-loop/   │
   └──────────────┘        └──────────┬──────┘
                                      │
                   ┌──────────────────┼───────────────────┐
                   ▼                  ▼                    ▼
          ┌──────────────┐  ┌──────────────────┐  ┌─────────────────┐
          │learnerWorker │  │ executorWorker   │  │ messageProvider │
          │(get_skill →  │  │  (ToolsQueue →   │  │  (AI chat /     │
          │learned_skills│  │ recursive loop)  │  │  chatStream)    │
          └──────────────┘  └──────────────────┘  └─────────────────┘
                                      │
                        ┌─────────────┴──────────────┐
                        ▼                            ▼
                ┌──────────────┐             ┌──────────────┐
                │ execute_     │             │ curl_request │
                │ command      │             │              │
                └──────────────┘             └──────────────┘
```

---

## Entry Point (`apps/client/src/app.ts`)

Parses CLI flags `--tui`, `--telegram`, `--web` and starts the appropriate channel. Defaults to Telegram + Web if no flag given.

---

## `apps/client/src` — Directory Reference

```
src/
├── app.ts                    Entry point
├── config/index.ts           Env + settings.json loader → exports `config`
├── constants/prompt.ts       All prompt templates (SYSTEM_PROMPT, FIRST_PROMPT_HELPER,
│                             SKILL_LEARNING_PROMPT, SKILL_READY_PROMPT,
│                             TOOLS_RESULT_PROMPT, SUMMARIZATION_PROMPT)
├── entities/
│   ├── memory.ts             Memory entity (id, sessionId, type, content, embedding, tags)
│   ├── message.ts            Message entity (id, sessionId, role, content, createdAt)
│   └── session.ts            Session entity (id, source, startedAt, messageCount, metadata)
├── infrastructure/
│   ├── db-sqlite.ts          SQLite wrapper (better-sqlite3); tables: sessions, messages,
│   │                         memories, learned_skills; exports DatabaseServiceFactory
│   └── logger.ts             Winston logger; ILogger; LoggerFactory.create();
│                             5MB×5 rotation; silences console in TUI mode
├── repositories/
│   ├── learned-skills.ts     CRUD for learned_skills table
│   ├── memory.ts             CRUD for memories table
│   ├── message.ts            CRUD for messages table (getBySessionId)
│   ├── prompt.ts             Builds full AIChatRequest (system + memory + skills + history + tools)
│   ├── session.ts            CRUD for sessions table
│   ├── skills.ts             Reads SKILL.md files from ./skills/ on disk
│   ├── system-info.ts        Loads channel-aware system prompt context
│   └── tools.ts              Returns AIToolDefinition[] for all registered tools
├── services/
│   ├── memory-service.ts     save, upsert (merges content/tags), getAll
│   ├── message-service.ts    save (persists to DB), getHistory (by sessionId)
│   ├── provider-health-service.ts  healthCheck() → {status, timestamp}
│   ├── session-service.ts    getSession(), updateCount()
│   ├── agents/               ← Core agent logic (see below)
│   ├── providers/            ← AI providers (see below)
│   └── tools-queue/          ← Tool execution (see below)
├── channels/
│   ├── telegram/index.ts     Telegram message handler + approval keyboard
│   ├── tui/index.ts          TUI wiring (assistant-tui + markdown renderer)
│   └── web/index.ts          Express 5: GET /, POST /api/chat (SSE), GET /health
├── types/                    agents.ts, memory.ts, messages.ts, provider.ts, skills.ts, tools.ts
└── utils/
    ├── fields.ts             camelToSnakeCase()
    ├── history.ts            isSkillAlreadyLearned()
    ├── prompt.ts             replacePlaceholders()
    ├── provider.ts           validateBaseUrl() — blocks remote URLs by default
    ├── sanitize-log-text.ts  sanitizeLogText(), sanitizeMeta() — strips control chars, handles circular refs
    ├── telegram.ts           escapeTelegramMarkdown(), isAbortError()
    └── tool-calls.ts         extractToolCalls(), normalizeResponse(), shouldSkipToolCall()
```

---

## Agent Layer (`services/agents/`)

### `handler.ts` — `AgentHandler` + `AgentHandlerFactory`

The main orchestrator. `AgentHandlerFactory.create(logger, channel)` wires DB → session → message → memory services, then returns an `AgentHandler`.

**`AgentHandler.handle(message, options?)`**:
1. Sanitizes input via `toSafeMessage()`
2. `/command` → `handleCommand()`, persists exchange, returns
3. Otherwise → `manager()` (agentic loop)
4. If manager returns `AsyncGenerator` → `persistAssistantStream()` (yields chunks, buffers, persists)
5. Fires `conversationWorker()` (DB persist) and `summarizerWorker()` (AI summarization → memories) as background tasks

### `commands/index.ts`

Slash command dispatcher. Exports: `handleCommand()`, `isCommand()`, `getAvailableCommands()`.

| Command | TUI | Telegram | Notes |
|---|---|---|---|
| `/start` | ✅ | ✅ | Welcome message |
| `/help` | ✅ | ✅ | List commands |
| `/status` | ✅ | ✅ | Session status |
| `/stats` | ✅ | ❌ | TUI session stats |
| `/clear` | ✅ | ✅ | Clear history |
| `/reset` | ✅ | ✅ | Reset session |
| `/exit` `/quit` `/bye` | ✅ | ❌ | TUI only |

Channel-aware: Telegram uses MarkdownV2; TUI uses plain text.

### `tools-loop/manager.ts` — `manager()`

Agentic loop coordinator:
1. Fetches message history
2. Sends `FIRST_PROMPT_HELPER`-wrapped message to `messageProvider()` (non-stream, detects tool calls)
3. No tool calls → falls through to `messageProviderStream()` for the final streamed answer
4. Splits tool calls: `get_skill` → `learnerWorker` first, then re-queries AI; execute tools → `executorWorker`

### `tools-loop/executor-worker.ts` — `executorWorker()` (recursive, max 10)

1. Reports `Iteration N` via `onProgress`
2. Calls `ToolsQueue.handle()` with current tool calls
3. Sends `TOOLS_RESULT_PROMPT` to `messageProviderStream()`
4. Extracts further tool calls → recurses (max `maxIterations = 10`)

### `tools-loop/learner-worker.ts` — `learnerWorker()`

1. Executes `get_skill` tool calls via `ToolsQueue`
2. Builds `SKILL_LEARNING_PROMPT` with skill name + content
3. Saves to `learned_skills` table if not already present

### `chat/message-provider.ts` / `message-provider-stream.ts`

Both call `PromptRepositoryFactory` to build the full `AIChatRequest`.
- `messageProvider()` → `provider.chat()` (non-streaming)
- `messageProviderStream()` → `provider.chatStream()` for Ollama+TUI; falls back to `provider.chat()` otherwise

### `conversation/index.ts` — `conversationWorker()`

Persists `{role: user}` + `{role: assistant}` messages to DB after each turn (fire-and-forget).

### `summarizer/index.ts` — `summarizerWorker()`

Calls `provider.chat()` with `SUMMARIZATION_PROMPT`; upserts 1–3 sentence summary to the `memories` table.

---

## AI Providers (`services/providers/`)

Selected via `config.AI.PROVIDER` (env `AI_PROVIDER`). Forced to `mock` when `VITEST=true`.

**Registry exports**: `getAIProvider({ logger })` (singleton cache), `clearProviderCache()`, `getSupportedProviders()` → `['ollama', 'mock']`.

### `OllamaAIProvider`

| Method | Behaviour |
|---|---|
| `chat(request, options?)` | Non-streaming `/api/chat`; handles `tool_calls` in JSON response; hard timeout 15m |
| `chatStream(request, options?)` | Streaming NDJSON `/api/chat`; idle timeout 90s; hard timeout 15m; yields string chunks |
| `healthCheck()` | `GET /api/version`; 5s timeout; returns `{ ok, detail: 'vX.Y.Z' }` |

Defaults: model `gemma4:e2b`, base URL `http://localhost:11434`. Blocks non-localhost URLs unless `AI_ALLOW_REMOTE_BASE_URL=true`.

### `MockAIProvider`

No network calls. `chat()` echoes last user message. `chatStream()` yields the same string char-by-char. `healthCheck()` always returns `{ ok: true }`. Used in all unit tests.

---

## Tools (`services/tools-queue/tools/`)

All tools implement `CommandFn = (logger: ILogger, args: Record<string, unknown>) => Promise<ToolResult>`.

`ToolsQueue` (in `tools-queue/index.ts`) runs **up to 2 concurrent tools** (`p-limit(2)`) and dispatches via `COMMAND_MAP`.

### `execute_command`

Runs a shell command inside `BASE_DIR`. **Strict allowlist**: `ls`, `git`, `npm`, `cat`, `echo` only — anything else returns a security error.

| Arg | Type | Required | Notes |
|---|---|---|---|
| `command` | `string` | ✅ | Command name or tokenized string like `"ls -la"` |
| `args` | `string[]` | optional | Explicit args array; overrides tokenized command args |

- Uses `spawnCommand()` with `shell: false` (no injection possible)
- Truncates stdout to **20000 chars**

### `get_skill`

Reads `./skills/<skill_path>/SKILL.md`, strips YAML frontmatter.

| Arg | Type | Required | Notes |
|---|---|---|---|
| `skill_name` | `string` | ✅ | Logical skill name |
| `skill_path` | `string` | ✅ | Relative sub-path under `skills/` |

- Path traversal guard: resolves and validates path stays inside `BASE_SKILLS_DIR`
- Parses frontmatter with `gray-matter`; returns `.content` only
- Truncates to **5000 chars**

### `curl_request`

Makes HTTP requests via `execFile('curl', ...)` — no shell. Optional jq pipe (also shell-free).

| Arg | Type | Required | Notes |
|---|---|---|---|
| `url` | `string` | ✅ | Target URL; auto-prefixes `https://`; extracts URL if model passed a full `curl ...` shell command |
| `method` | `string` | optional | Default `GET`; allowed: GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS |
| `timeout` | `number` | optional | Seconds; default 30 |
| `follow_redirects` | `boolean` | optional | Adds `-L`; default `true` |
| `headers` | `Record<string,string>` | optional | Key-value header map |
| `data` | `string` | optional | Request body (POST/PUT/PATCH only) |
| `pipe` | `string` | optional | jq invocation e.g. `"| jq -r '.result'"` |

- URL validated with `new URL()`; extracted from shell commands via `shellWords()` (no regex shell parsing)
- `pipe` parsed into safe argv — **never passed to a shell**; rejects anything that doesn't start with `jq`
- Injects `-w '\n---HTTP_STATUS:%{http_code}---'` to extract HTTP status without a shell
- Returns `success: false` for HTTP 4xx/5xx
- Truncates response to **5000 chars**

### `shared/runtime.ts`

Safe helpers used by all tools:
- Arg extractors: `getRequiredStringArg`, `getOptionalStringArg`, `getOptionalStringArrayArg`, `getOptionalNumberArg`, `getOptionalBooleanArg`, `getOptionalStringRecord`, `isAllowedValue`
- `execFilePromise(cmd, args, timeoutMs)` — wraps `execFile` with timeout + max buffer
- `spawnCommand({ command, args, cwd, shell, maxOutputSize })` — wraps `spawn` with no shell, collects stdout/stderr

---

## Channels

### Web (`channels/web/index.ts`)

Express 5 server. Exports: `createApp()`, `startWebServer()`.

| Route | Description |
|---|---|
| `GET /` | Serves `public/chat/index.html`; IP rate-limit: 60 req/60s (auto-evicts map > 5000 keys) |
| `POST /api/chat` | SSE stream; calls `AgentHandler.handle()`; emits `{type:'progress'}` + `{type:'content_block_delta'}`; sends `[DONE]`; respects client disconnect via `AbortController` |
| `GET /health` | Calls `provider-health-service.healthCheck()`; returns `{status, timestamp, details}` |

Default WEB_PORT: `config.WEB_PORT` (env `WEB_PORT`, default 3000).

### TUI (`channels/tui/index.ts`)

Wires `assistant-tui` library with `AgentHandlerFactory`. Features:
- Scrollable history with fixed input layout
- Markdown renderer: headings → colored symbols, code blocks → green, bold/italic/inline-code
- Command autocomplete popup triggered by `/`
- Progress callbacks: parses `"Iteration N"` → badge; other progress → colored dot + headline/details
- Streaming enabled for Ollama (`messageProviderStream`)
- Model name shown in footer

### Telegram (`channels/telegram/index.ts`)

Wraps `assistant-telegram-bot`. Exports: `handleMessage()`, `sendCode()`, `sendWithApproval()`.
- Sends typing indicator (refreshed every 5s)
- Resolves `AsyncGenerator` streams before sending
- Tries MarkdownV2 first; falls back to plain text on parse error
- `sendWithApproval()` sends inline keyboard with ✅ Approve / ❌ Reject buttons

---

## Configuration

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `AI_PROVIDER` | `ollama` | Provider: `ollama` or `mock` |
| `AI_BASE_URL` | `http://localhost:11434` | Ollama endpoint |
| `AI_MODEL` | `gemma4:e2b` | Model name |
| `AI_ALLOW_REMOTE_BASE_URL` | `false` | Allow non-localhost Ollama URLs |
| `AI_API_TOKEN` | `""` | Auth token for AI endpoint |
| `TELEGRAM_BOT_TOKEN` | `""` | Bot token from @BotFather |
| `TELEGRAM_WEBHOOK_URL` | `""` | Webhook URL (polling used by default) |
| `PORT` | `3000` | Web server port |
| `LOG_LEVEL` | `info` | Winston log level |
| `LOG_SILENCE_CONSOLE` | `""` | Set `true` to suppress console output (auto-set in TUI) |
| `TIMEZONE` | `AMERICA/Sao_Paulo` | Informational timezone |
| `ENVIRONMENT` | `development` | Enables SQLite WAL mode in development |

Config can also be read from **`settings.json`** (dot-path notation, e.g. `ai.MODEL`). Env vars take priority.

### Logging

Winston logger (`infrastructure/logger.ts`):
- File transports: `logs/combined.log` (all) and `logs/error.log` (errors)
- Rotation: 5 MB × 5 files
- Console transport silenced automatically in TUI mode

---

## CI / CD (`.github/workflows/`)

| Workflow | Triggers | Key Steps |
|---|---|---|
| `tests.yml` | push/PR to `main`, `develop` | install → build → `test:coverage` → parse `coverage/coverage-final.json` → annotate (threshold 80%) → upload to Codecov |
| `lint.yml` | push to `main`, `develop` | install → `pnpm lint` (TypeScript `--noEmit`) |
| `codeql.yml` | weekly cron (Mon 02:00 UTC) + manual | CodeQL `security-extended` (200+ patterns: injection, traversal, XSS, ReDoS, etc.) → upload `.sarif` |

---

## Database Schema (SQLite via `better-sqlite3`)

| Table | Key Columns |
|---|---|
| `sessions` | `id`, `source`, `started_at`, `ended_at`, `message_count`, `metadata` |
| `messages` | `id`, `session_id`, `role`, `content`, `created_at` |
| `memories` | `id`, `session_id`, `type`, `content`, `embedding`, `tags`, `importance` |
| `learned_skills` | `id`, `session_id`, `skill_name`, `content` |

---

## Testing

All tests in `apps/client/tests/unit/`, run with **Vitest**.

```bash
pnpm test                          # run all tests (uses mock provider)
pnpm --filter koris-agent test:coverage
```

Tests default to `AI_PROVIDER=mock` whenever `VITEST=true` — no Ollama server needed.

### Test Files

| File | Covers |
|---|---|
| `entities/message.test.ts` | Message entity construction, uuid |
| `entities/session.test.ts` | Session entity, messageCount, metadata |
| `channels/web/index.test.ts` | Rate-limiting, health endpoint, SSE streaming, 400 handling |
| `services/agent/commands.test.ts` | All slash commands, TUI vs Telegram formatting, exit guards |
| `services/providers/ollama.provider.test.ts` | NDJSON streaming, non-stream fallback, tool forwarding |
| `services/providers/mock.provider.test.ts` | Full mock provider contract, streaming, abort, healthCheck |
| `services/tools-queue/index.test.ts` | Concurrency (p-limit), unknown tool, error handling |
| `services/tools-queue/tools/curl-command.test.ts` | `parseJqArgs`, `shellWords`, `buildCurlArgs`, `executeCurl`; injection resistance; URL normalization |
| `services/tools-queue/tools/execute-command.test.ts` | Allowlist enforcement, injection blocking, quoted args, truncation |
| `services/tools-queue/tools/get-skill.test.ts` | Path traversal guard, frontmatter stripping, truncation |
| `services/tools-queue/tools/shared/runtime.test.ts` | All arg extractors, edge cases |
| `utils/history.test.ts` | `isSkillAlreadyLearned` across message roles |
| `utils/tool-calls.test.ts` | `extractToolCalls`, `normalizeResponse`, `shouldSkipToolCall` |
| `utils/fields.test.ts` | `camelToSnakeCase` |
| `utils/prompt.test.ts` | `replacePlaceholders` |
| `utils/provider.test.ts` | `validateBaseUrl` — localhost/remote/credentials |
| `utils/sanitize-log-text.test.ts` | Control char removal, circular refs, Error objects |
| `utils/telegram.test.ts` | `escapeTelegramMarkdown`, `isAbortError` |
| `services/helpers/helpers.test.ts` | `toSafeMessage`, `previewMessage` |

---

## Security Principles

1. **No shell** — all child processes use `execFile` / `spawn` with `shell: false`. Shell operators in inputs are inert.
2. **Command allowlist** — `execute_command` blocks everything except `ls`, `git`, `npm`, `cat`, `echo`.
3. **Path traversal guard** — `get_skill` resolves and bounds-checks every path against `BASE_SKILLS_DIR`.
4. **URL validation** — `curl_request` parses URLs with `new URL()` and blocks remote AI endpoints unless explicitly allowed.
5. **jq pipe isolation** — pipe strings are tokenized into argv arrays; only `jq` invocations are accepted; no shell is ever involved.
6. **Token safety** — never log `TELEGRAM_BOT_TOKEN` or `AI_API_TOKEN`; `sanitizeMeta()` scrubs log output.
7. **Rate limiting** — Web channel: 60 req/60s per IP.
8. **CodeQL** — weekly `security-extended` scan covers 200+ vulnerability patterns.

---

## Extension Guide

### Adding a New Tool

1. Create `apps/client/src/services/tools-queue/tools/<tool-name>/index.ts` exporting a `CommandFn`.
2. Register it in `tools/index.ts` `COMMAND_MAP`.
3. Add its `AIToolDefinition` in `repositories/tools.ts`.
4. Write tests in `tests/unit/services/tools-queue/tools/<tool-name>.test.ts`.

### Adding a New Slash Command

1. Add the case in `services/agents/commands/index.ts` → `handleCommand()`.
2. Implement a handler function returning `CommandResult` with appropriate `action` and channel-aware formatting.
3. Update `getAvailableCommands()` if it should appear in `/help`.

### Adding a New Channel

1. Create `channels/<name>/index.ts`.
2. Wire it in `app.ts` behind a CLI flag.
3. Pass `channel` string to `AgentHandlerFactory.create(logger, '<name>')`.

---

## File Structure Summary

```
apps/
├── client/                        Main app
│   ├── src/
│   │   ├── app.ts
│   │   ├── config/
│   │   ├── constants/             Prompt templates
│   │   ├── entities/              message, session, memory
│   │   ├── infrastructure/        SQLite, Winston logger
│   │   ├── repositories/          DB access + prompt builder
│   │   ├── services/
│   │   │   ├── agents/            handler, commands, tools-loop, chat, summarizer
│   │   │   ├── providers/         ollama, mock
│   │   │   └── tools-queue/       ToolsQueue + execute_command, get_skill, curl_request
│   │   ├── channels/              tui, web, telegram
│   │   ├── types/
│   │   └── utils/
│   ├── public/chat/               index.html, main.js, styles.css
│   ├── tests/unit/
│   ├── skills/                    SKILL.md files (runtime)
│   └── logs/                      combined.log, error.log (runtime)
├── assistant-tui/                 Reusable TUI lib
├── telegram-bot/                  Reusable Telegram lib
└── sh-compression/                CLI proxy + helpers

.github/workflows/                 tests.yml, lint.yml, codeql.yml
AGENTS.md                          This file
README.md
```

---

**Last Updated**: 2026-04-27
**Version**: 1.2.0
**Status**: Ollama integration active with full tool execution. Web, TUI, and Telegram channels operational.
