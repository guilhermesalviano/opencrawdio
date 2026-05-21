import { existsSync } from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { config } from '../config';
import { ILogger } from '../infrastructure/logger';
import { IAgent } from '../services/agents/main-agent/agent';

function getGoBinaryPath(): string {
  const candidates = [
    // Running compiled: dist/src/tui/index.js → dist/src/tui → 3 levels up = apps/client
    path.resolve(__dirname, '../../../bin/go-tui'),
    // Running from source with tsx: src/tui/index.ts → src/tui → 2 levels up = apps/client
    path.resolve(__dirname, '../../bin/go-tui'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  throw new Error(
    `go-tui binary not found. Run 'pnpm run build:go-tui' to compile it.\nSearched:\n  ${candidates.join('\n  ')}`,
  );
}

export function startTUI(params: { logger: ILogger; agent: IAgent }): void {
  const { logger } = params;

  let binaryPath: string;
  try {
    binaryPath = getGoBinaryPath();
  } catch (err) {
    logger.error((err as Error).message);
    process.exit(1);
  }

  const serverURL = `http://localhost:${config.WEB_PORT}`;
  logger.info(`Launching go-tui → ${serverURL}`);

  const child = spawn(binaryPath, ['--server', serverURL, '--model', config.AI.MODEL], {
    stdio: 'inherit',
  });

  child.on('error', (err) => {
    logger.error('Failed to launch go-tui', { error: err.message });
    process.exit(1);
  });

  child.on('exit', (code) => {
    process.exit(code ?? 0);
  });
}

