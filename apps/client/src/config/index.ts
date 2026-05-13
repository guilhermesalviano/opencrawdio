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
  LOG_LEVEL:   get('log.level', 'info'),
  TIMEZONE:    get('timezone', 'AMERICA/Sao_Paulo'),
  ENVIRONMENT: get('environment', 'development'),
  TEMP_FOLDER: get('temp_folder', './temp'),
  WEB_PORT:    Number(get('web_port', '3000')),
  BASE_DIR:    process.cwd(),
  GMAIL: {
    GATEWAY_HOST: get('gmail.gateway_host', 'http://localhost:3000'),
  },
  HEARTBEAT: {
    ENABLED: get('heartbeat.enabled', 'true') === 'true',
    INTERVAL_MS: Number(get('heartbeat.interval_ms', (30 * 60 * 1000).toString())),
    ACTIVE_HOURS: {
      START: get('heartbeat.active_hours.start', '08:00'),
      END: get('heartbeat.active_hours.end', '22:00'),
    },
  },
  AI: {
    PROVIDER: process.env.VITEST === 'true' ? 'mock' : get('ai.provider', 'ollama'),
    ALLOW_REMOTE_BASE_URL: get('ai.allow_remote_url', 'false') === 'true',
    BASE_URL:  get('ai.base_url', 'http://localhost:11434'),
    API_TOKEN: get('ai.api_token', ''),
    MODEL:     get('ai.model', 'gemma4:e2b'),
    TIMEOUTS: {
      IDLE_MS:   Number(get('ai.timeouts.idle_ms', String(6 * 60_000))),
      HARD_MS:   Number(get('ai.timeouts.hard_ms', String(20 * 60_000))),
      HEALTH_MS: Number(get('ai.timeouts.health_ms', String(5_000))),
    },
  },
  CHANNELS: {
    TELEGRAM: {
      ENABLED:     get('channels.telegram.enabled', 'false') === 'true',
      USE_POLLING: get('channels.telegram.use_polling', 'true') === 'true',
      BOT_TOKEN:   get('channels.telegram.bot_token', ''),
      CHAT_ID:     get('channels.telegram.chat_id', ''),
    },
  },
  PERSONAL_INFORMATION: {
    NAME:       get('personal_information.name', ''),
    GENDER:     get('personal_information.gender', ''),
    BIRTHDAY:   get('personal_information.birthday', ''),
    LOCATION:   get('personal_information.location', ''),
    OCCUPATION: get('personal_information.occupation',''),
  },
} as const;

const isTelegramMode = process.argv.includes('telegram') || process.argv.includes('--telegram');
if (!isTest && isTelegramMode && !config.CHANNELS.TELEGRAM.BOT_TOKEN) {
  console.error('ERROR: channels.telegram.bot_token is required');
  console.error('Please set channels.telegram.bot_token in settings.json or CHANNELS_TELEGRAM_BOT_TOKEN as an environment variable');
  process.exit(1);
}
