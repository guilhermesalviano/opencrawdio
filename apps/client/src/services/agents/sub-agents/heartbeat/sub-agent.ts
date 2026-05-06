import { config } from "../../../../config";
import { DatabaseServiceFactory } from "../../../../infrastructure/db-sqlite";
import { HeartbeatRepositoryFactory, IHeartbeatRepository } from "../../../../repositories/heartbeat";
import { isCronDue } from "../../../../utils/heartbeat";
import { IPromptRepository, PromptRepositoryFactory } from "../../../../repositories/prompt";
import { getAIProvider } from "../../../providers";
import { ISkillsRepository, SkillsRepositoryFactory } from "../../../../repositories/skills";
import { replacePlaceholders } from "../../../../utils/prompt";
import { HEARTBEAT_PROMPT } from "../../../../constants";
import type { ILogger } from "../../../../infrastructure/logger";
import { extractToolCalls, normalizeResponse } from "../../../../utils/tool-calls";
import { IToolsQueue, ToolsQueue } from "../../../tools-queue";
import { ExecutorWorkerFactory } from "../../../workers/executor-worker";
import { ISubAgent } from "../../../../types/agents";
import { mkdirSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { AgnosticExecutionToolFactory } from "../../../tools";
import { IChannelsManager } from "../../../../channels";

class Heartbeat implements ISubAgent {
  constructor(
    private logger: ILogger,
    private promptRepository: IPromptRepository,
    private heartbeatRepository: IHeartbeatRepository,
    private skillsRepository: ISkillsRepository,
    private toolsQueue: IToolsQueue, 
    private channelsManager: IChannelsManager,
  ) { }

  async handler(date: Date): Promise<void> {
    const provider = getAIProvider(this.logger);
    const executorWorker = ExecutorWorkerFactory.create(this.logger);
    const tasks = this.heartbeatRepository.getAll();
    const skills = this.skillsRepository.get();

    const [ start, end ] = this.activeHoursHelper();

    if (date < start || date > end) {
      this.logger.info(`Heartbeat skipped: Current time (${date.toLocaleTimeString()}) is outside of active hours (${start.toLocaleTimeString()} - ${end.toLocaleTimeString()}).`);
      return;
    }
    this.logger.info('Heartbeat: Agent is alive and functioning.');


    if (tasks.length === 0) {
      this.logger.info('Heartbeat: No scheduled tasks found.');
      return;
    }

    // if dont have task, keep necessity to execute AI 
    for (const task of tasks) {
      const since = task.lastRun ?? new Date(date.getTime() - config.HEARTBEAT.INTERVAL_MS);

      if (!isCronDue(task.cronExpression, date, since)) {
        this.logger.info(`Heartbeat: Task "${task.id}" not due yet (cron: ${task.cronExpression}).`);
        continue;
      }

      this.logger.info(`Heartbeat: Executing task "${task.id}" — ${task.task}`);
      const prompt = replacePlaceholders(HEARTBEAT_PROMPT, { v1: `${task.type}`, v2: `task: ${task.task}` });

      try {
        // refactor - usar um novo tipo de manager para heartbeat tasks, que não precisa de message history, channel, etc. Talvez só passar o texto da task e um contexto com logger.
        const payload = this.promptRepository.withConfig({ includeTaskTools: false }).build({
        userMessage: prompt, 
        channel: 'tui', 
        skills, 
        toolsEnabled: true,
        messageHistory: []
      });

        // this.logger.debug(`heartbeat prompt value ${JSON.stringify(payload)}`);
      
        const providerResult = await provider.chat(payload);

        let executorResult = '';
        if (!this.isAsyncGen(providerResult)) {
          const responseText = normalizeResponse(providerResult);
          const toExecute = extractToolCalls(responseText);

          if (toExecute.length === 0) {
            executorResult = responseText;
          } else {
            const executed = await executorWorker.run({
              toolCalls: toExecute,
              userMessage: task.task,
              messageHistory: [],
              ctx: {
                channel: 'tui',
                toolsQueue: this.toolsQueue,
                signal: new AbortController().signal,
                onProgress: (progress: string) => this.logger.info(progress),
                options: { toolsEnabled: true },
              },
            });
            executorResult = await this.toText(executed);
          }
        }
        const result = executorResult || providerResult;
        this.saveTaskResult({ taskId: task.id, date, result });

        this.logger.info(`Heartbeat: Task "${task.id}" executed. Result: ${result}`);

        // Hardcoded for tests
        this.channelsManager.sendMessage('telegram', config.CHANNELS.TELEGRAM.CHAT_ID, result).catch(err => {
          this.logger.error(`Failed to send heartbeat result to Telegram for task "${task.id}".`, { err });
        });

        this.heartbeatRepository.updateLastRun(task.id, date);
        this.logger.info(`Heartbeat: Task "${task.id}" completed successfully.`);
      } catch (err) {
        this.logger.error(`Heartbeat: Task "${task.id}" failed.`, { err });
      }
    }
  }

  isAsyncGen(val: unknown): val is AsyncGenerator<string> {
    return typeof val === 'object' && val !== null && Symbol.asyncIterator in val;
  }

  async toText(value: string | AsyncGenerator<string>): Promise<string> {
    if (typeof value === 'string') {
      return value;
    }

    let fullText = '';
    for await (const chunk of value) {
      fullText += chunk;
    }

    return fullText;
  }

  activeHoursHelper(): Date[] {
    const start = new Date();
    const [startHour, startMinute] = config.HEARTBEAT.ACTIVE_HOURS.START.split(':').map(Number);
    start.setHours(startHour, startMinute, 0, 0);

    const end = new Date();
    const [endHour, endMinute] = config.HEARTBEAT.ACTIVE_HOURS.END.split(':').map(Number);
    end.setHours(endHour, endMinute, 0, 0);

    return [start, end];
  }

  formatDateStamp(date: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${date.getFullYear()}_${pad(date.getMonth() + 1)}_${pad(date.getDate())}_${pad(date.getHours())}_${pad(date.getMinutes())}`;
  }

  saveTaskResult(props: { taskId: string; date: Date; result: string }): void {
    const { taskId, date, result } = props;
    const tempDir = resolve(config.BASE_DIR, config.TEMP_FOLDER);
    const filename = `${taskId}_${this.formatDateStamp(date)}.md`;
    const filePath = join(tempDir, filename);

    try {
      mkdirSync(tempDir, { recursive: true });
      writeFileSync(filePath, result, 'utf-8');
      this.logger.info(`Heartbeat: Task result saved to ${filePath}`);
    } catch (err) {
      this.logger.error(`Heartbeat: Failed to save task result to ${filePath}`, { err });
    }
  }
}

class HeartbeatFactory {
  static create(logger: ILogger, channelsManager: IChannelsManager): Heartbeat {
    const db = DatabaseServiceFactory.create();
    const promptRepository = PromptRepositoryFactory.create(db);
    const heartbeatRepository = HeartbeatRepositoryFactory.create(db);
    const skillsRepository = SkillsRepositoryFactory.create(logger);
    const agnosticExecutionTool = AgnosticExecutionToolFactory.create();
    const toolsQueue = new ToolsQueue(logger, agnosticExecutionTool);

    return new Heartbeat(logger, promptRepository, heartbeatRepository, skillsRepository, toolsQueue, channelsManager);
  }
}

export { HeartbeatFactory };
