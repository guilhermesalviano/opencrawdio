// Must run before any module-level LoggerFactory.create() calls (e.g. db-sqlite.ts).
// Detecting --tui flag directly from argv here silences the console transport
// globally, preventing any log output from breaking the TUI alt-screen layout.
if (process.argv.includes('tui') || process.argv.includes('--tui')) {
  process.env.LOG_SILENCE_CONSOLE = 'true';
}

import { startTUI } from './tui';
import { LoggerFactory, ILogger } from './infrastructure/logger';
import { AgentFactory, IAgent } from './services/agents/main-agent/agent';
import { IHeartbeatRunner, HeartbeatSingleton } from './services/agents/sub-agents/heartbeat/runner';
import { ChannelsSingleton, IChannelsManager } from './channels';
import { SHUTDOWN_SIGNALS } from './constants/tui';
import { hasFlag, logError } from './utils/runtime';
import { DatabaseServiceFactory } from './infrastructure/db-sqlite';
import { SessionServiceFactory } from './services/session-service';
import { config } from './config';
import { DashboardServerFactory, WebServerHandle } from './dashboard';

const logger = LoggerFactory.create();
const MODES = ['tui', 'web'] as const;

type Mode = typeof MODES[number];
type RuntimeModes = Record<Mode, boolean>;

interface IRuntime {
  agent: IAgent;
  channels: IChannelsManager;
  heartbeat: IHeartbeatRunner;
  webServer: WebServerHandle | null;
};

interface IApplication {
  start(): Promise<void>;
}

class Application implements IApplication {
  private runtime: IRuntime | null = null;
  private isShuttingDown = false;

  constructor(
    private readonly logger: ILogger,
    private readonly source: Mode = resolveSessionSourceFromArgs(),
    private readonly modes: RuntimeModes = resolveRuntimeModes(),
  ) {}

  async start(): Promise<void> {
    this.runtime = await this.createCliRuntime();
    this.registerShutdownHandlers();
    this.startTuiIfEnabled();
  }

  private async createCliRuntime(): Promise<IRuntime> {
    const db = DatabaseServiceFactory.create();
    const session = SessionServiceFactory.create(db, this.source);
    const agent = AgentFactory.create(this.logger, this.source, db, session);

    const channels = ChannelsSingleton.getInstance(this.logger, agent);
    const heartbeat = HeartbeatSingleton.getInstance(this.logger, config.HEARTBEAT.INTERVAL_MS, channels);

    if (config.CHANNELS.TELEGRAM.BOT_TOKEN) {
      channels.startAll();
    }

    heartbeat.start();

    try {
      const webServer = this.modes.web
        ? await DashboardServerFactory.create(this.logger, agent).start()
        : null;

      return { agent, channels, heartbeat, webServer };
    } catch (error) {
      channels.stopAll();
      heartbeat.stop();
      throw error;
    }
  }

  private startTuiIfEnabled(): void {
    if (!this.runtime || !this.modes.tui) {
      return;
    }

    startTUI({ logger: this.logger, agent: this.runtime.agent });
  }

  private registerShutdownHandlers(): void {
    for (const signal of SHUTDOWN_SIGNALS) {
      process.once(signal, () => {
        void this.shutdown(signal, 0);
      });
    }

    process.once('beforeExit', () => {
      void this.shutdown('beforeExit');
    });
  }

  private async shutdown(reason: string, exitCode?: number): Promise<void> {
    if (this.isShuttingDown || !this.runtime) {
      return;
    }

    this.isShuttingDown = true;
    this.logger.info(`Shutting down application (${reason})...`);

    this.runtime.channels.stopAll();
    this.runtime.heartbeat.stop();

    try {
      await this.runtime.webServer?.stop();
    } catch (error) {
      logError(this.logger, `Failed to stop web server during ${reason}.`, error);
    }

    if (exitCode !== undefined) {
      process.exit(exitCode);
    }
  }
}

function resolveRuntimeModes(argv: string[] = process.argv): RuntimeModes {
  const explicitModes = MODES.reduce<RuntimeModes>((modes, mode) => {
    modes[mode] = hasFlag(mode, argv);
    return modes;
  }, { tui: false, web: false });

  if (Object.values(explicitModes).some(Boolean)) {
    return explicitModes;
  }

  return {
    tui: false,
    web: true,
  };
}

function resolveSessionSourceFromArgs(argv: string[] = process.argv): Mode {
  const modesArg = resolveRuntimeModes(argv);

  for (const mode of MODES) {
    if (modesArg[mode]) {
      return mode;
    }
  }

  return 'web';
}

const app = new Application(logger);

if (require.main === module) {
  app.start().catch((error) => {
    logError(logger, 'Failed to start application.', error);
    process.exit(1);
  });
}
