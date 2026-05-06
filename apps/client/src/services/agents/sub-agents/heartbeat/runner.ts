import { config } from '../../../../config';
import { IChannelsManager } from '../../../../channels';
import type { ILogger } from '../../../../infrastructure/logger';
import { HeartbeatFactory } from './sub-agent';
import { beginFooterActivity } from '../../../../utils/footer-activity';

interface IHeartbeatRunner {
  start(): void;
  stop(): void;
}

class HeartbeatRunner implements IHeartbeatRunner {
  private isRunning = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private logger: ILogger,
    private intervalMs: number,
    private channelsManager: IChannelsManager,
  ) {}

  start(): void {
    if (!config.HEARTBEAT.ENABLED) {
      this.logger.info('Heartbeat disabled by configuration.');
      return;
    }

    if (this.timer) {
      return;
    }

    this.timer = setInterval(() => {
      void this.runOnce();
    }, this.intervalMs);
  }

  stop(): void {
    if (!this.timer) {
      return;
    }

    clearInterval(this.timer);
    this.timer = null;
  }

  private async runOnce(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('Heartbeat tick skipped because the previous run is still active.');
      return;
    }

    this.isRunning = true;
    const endFooterActivity = beginFooterActivity('heartbeat');
    const date = new Date();
    this.logger.info(`[${date.toISOString()}] Agent waking up...`);

    try {
      const agent = HeartbeatFactory.create(this.logger, this.channelsManager);
      await agent.handler(date);
    } catch (error) {
      this.logger.error('Heartbeat failed.', {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      endFooterActivity();
      this.isRunning = false;
    }
  }
}

class HeartbeatSingleton {
  private static instance: IHeartbeatRunner;

  static getInstance(logger: ILogger, intervalMs: number, channelsManager: IChannelsManager): IHeartbeatRunner {
    if (!HeartbeatSingleton.instance) {
      HeartbeatSingleton.instance = new HeartbeatRunner(logger, intervalMs, channelsManager);
    }
    return HeartbeatSingleton.instance;
  }
}

export { IHeartbeatRunner, HeartbeatSingleton };
