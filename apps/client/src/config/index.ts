import 'dotenv/config';
import { getConfigValue, loadConfigFile } from './helpers';

const isTest = process.env.NODE_ENV === 'test';

const fileConfig = loadConfigFile({
  onParseError: (message) => console.warn(message),
});

function get(path: string, fallback: string): string {
  return getConfigValue(path, fallback, fileConfig);
}

export const config = {
  LOG_LEVEL:   get('log.LEVEL',   'info'),
  TIMEZONE:    get('TIMEZONE',    'AMERICA/Sao_Paulo'),
  ENVIRONMENT: get('ENVIRONMENT', 'development'),
  PORT:        Number(get('PORT', '3000')),
  GMAIL: {
    GATEWAY_HOST: get('gmail.GATEWAY_HOST', 'http://localhost:3000'),
  },
  BASE_DIR:    process.cwd(),
  TEMP_FOLDER: get('TEMP_FOLDER', './temp'),
  HEARTBEAT: {
    ENABLED: get('heartbeat.ENABLED', 'true') === 'true',
    INTERVAL_MS: Number(get('heartbeat.INTERVAL_MS', (30 * 60 * 1000).toString())), // Default to 30 minutes
    ACTIVE_HOURS: {
      START: get('heartbeat.ACTIVE_HOURS.START', '08:00'),
      END: get('heartbeat.ACTIVE_HOURS.END', '22:00'),
    },
  },
  AI: {
    PROVIDER: process.env.VITEST === 'true'
      ? 'mock'
      : get('ai.PROVIDER', 'ollama'),
    BASE_URL:  get('ai.BASE_URL',  'http://localhost:11434'),
    ALLOW_REMOTE_BASE_URL: get('ai.ALLOW_REMOTE_BASE_URL', 'false') === 'true',
    API_TOKEN: get('ai.API_TOKEN', ''),
    MODEL:     get('ai.MODEL',     'gemma4:e2b'),
  },
  CHANNELS: {
    TELEGRAM: {
      BOT_TOKEN:   get('channels.telegram.BOT_TOKEN',   ''),
      WEBHOOK_URL: get('channels.telegram.WEBHOOK_URL', ''),
      USE_POLLING: get('channels.telegram.USE_POLLING', 'true') === 'true',
      CHAT_ID:    get('channels.telegram.CHAT_ID',    ''),
    },
  },
  PERSONAL_INFORMATION: {
    HUMAN_NAME: get('personal_information.HUMAN_NAME', ''),
    HUMAN_GENDER: get('personal_information.HUMAN_GENDER', ''),
    HUMAN_BIRTHDAY: get('personal_information.HUMAN_BIRTHDAY', ''),
    HUMAN_LOCATION: get('personal_information.HUMAN_LOCATION', ''),
    HUMAN_OCCUPATION: get('personal_information.HUMAN_OCCUPATION', ''),
  },
} as const;

const isTelegramMode = process.argv.includes('telegram') || process.argv.includes('--telegram');
if (!isTest && isTelegramMode && !config.CHANNELS.TELEGRAM.BOT_TOKEN) {
  console.error('ERROR: TELEGRAM_BOT_TOKEN is required');
  console.error('Please set TELEGRAM_BOT_TOKEN in settings.json or as an environment variable');
  process.exit(1);
}
