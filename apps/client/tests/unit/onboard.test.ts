import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildOnboardingScreen,
  buildOnboardingSettings,
  Onboard,
  resolveOnboardingSettingsPath,
  saveOnboardingSettings,
  SETTINGS_FILENAME,
} from '../../src/onboard';

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'koris-onboard-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('buildOnboardingScreen', () => {
  it('asks for TELEGRAM_BOT_TOKEN when telegram is selected', () => {
    const screen = buildOnboardingScreen(
      {
        answers: {
          channels: ['telegram'],
        },
      },
      72,
      'plain',
    );

    expect(screen).toContain('2. Telegram bot token');
    expect(screen).not.toContain('3. Provider');
  });

  it('skips the Telegram token step when telegram is not selected', () => {
    const screen = buildOnboardingScreen(
      {
        answers: {
          channels: ['discord'],
        },
      },
      72,
      'plain',
    );

    expect(screen).toContain('2. Provider');
    expect(screen).not.toContain('Telegram bot token');
  });

  it('keeps the API token step active until it is answered or skipped', () => {
    const screen = buildOnboardingScreen(
      {
        answers: {
          channels: ['telegram'],
          telegramToken: '123456:token',
          provider: 'openai',
        },
      },
      72,
      'plain',
      );

    expect(screen).toContain('4. API token');
    expect(screen).not.toContain('5. Provider URL');
  });

  it('treats an empty API token as a completed answer and advances onboarding', () => {
    const screen = buildOnboardingScreen(
      {
        answers: {
          channels: ['telegram'],
          telegramToken: '123456:token',
          provider: 'openai',
          providerApiToken: '',
        },
      },
      72,
      'plain',
    );

    expect(screen).toContain('4. API token ─ configured');
    expect(screen).toContain('5. Provider URL');
  });

  it('renders personal detail steps as substeps of personal information', () => {
    const screen = buildOnboardingScreen(
      {
        answers: {
          channels: ['telegram'],
          telegramToken: '123456:token',
          provider: 'openai',
          providerApiToken: '',
          providerUrl: 'https://api.openai.com/v1',
          personalInfo: { enabled: true, name: 'Joe Doe' },
        },
      },
      72,
      'plain',
    );

    expect(screen).toContain('6. Your Information ─ true');
    expect(screen).toContain('6.1. Your name ─ Joe Doe');
    expect(screen).toContain('6.2. Gender');
    expect(screen).not.toContain('7. Your name');
  });
});

describe('Onboard footer progress', () => {
  it('keeps personal substeps under step 6 in the footer', () => {
    const onboard = new Onboard() as any;
    onboard.answers = {
      channels: ['telegram'],
      telegramToken: '123456:token',
      provider: 'openai',
      providerApiToken: '',
      providerUrl: 'https://api.openai.com/v1',
      personalInfo: { enabled: true, name: 'Joe Doe' },
    };
    onboard.skippedSteps = new Set();

    expect(onboard.getFooterText()).toBe('step 6/6');
  });

  it('creates the temp settings draft when onboarding completes from a false picker selection', () => {
    const repoRoot = createTempDir();
    const appRoot = join(repoRoot, 'apps', 'client');
    const previousCwd = process.cwd();

    mkdirSync(appRoot, { recursive: true });
    writeFileSync(join(appRoot, 'settings.json'), '{}');
    writeFileSync(join(appRoot, 'settings.example.json'), JSON.stringify({
      channels: {
        telegram: {
          ENABLED: true,
          BOT_TOKEN: 'YOUR_BOT_TOKEN',
          USE_POLLING: true,
          CHAT_ID: 'YOUR_CHAT_ID',
        },
      },
      ai: {
        PROVIDER: 'ollama',
        BASE_URL: 'http://localhost:11434',
        API_TOKEN: '',
      },
      personal_information: {
        HUMAN_NAME: 'John Doe',
      },
    }));

    try {
      process.chdir(repoRoot);

      const onboard = new Onboard() as any;
      onboard.answers = {
        channels: ['telegram'],
        telegramToken: '123456:token',
        provider: 'ollama',
        providerApiToken: '',
        providerUrl: 'http://localhost:11434',
      };
      onboard.skippedSteps = new Set();
      onboard.pickerStep = 'personalInformation';
      onboard.pickerIndex = 1;

      const redrawCalls: string[] = [];
      const inputValues: string[] = [];
      const ctx = {
        getInputValue: () => '',
        setInputValue: (value: string) => {
          inputValues.push(value);
        },
        redraw: () => {
          redrawCalls.push('redraw');
        },
      };

      expect(onboard.handleKeypress('', { name: 'return' }, ctx)).toBe(true);
      expect(readFileSync(join(appRoot, SETTINGS_FILENAME), 'utf-8')).toContain('"personal_information": {}');
      expect(inputValues).toContain('');
      expect(redrawCalls).toHaveLength(1);
    } finally {
      process.chdir(previousCwd);
    }
  });
});

describe('onboarding settings draft', () => {
  it('builds a temp settings payload by overlaying onboarding answers on the example settings', () => {
    expect(buildOnboardingSettings({
      channels: ['telegram', 'discord'],
      telegramToken: '123456:token',
      provider: 'openai',
      providerUrl: 'https://api.openai.com/v1',
      providerApiToken: 'secret-token',
      personalInfo: {
        enabled: true,
        name: 'Joe Doe',
        gender: 'male',
      },
    }, {
      baseSettings: {
        TEMP_FOLDER: './temp',
        channels: {
          telegram: {
            ENABLED: true,
            BOT_TOKEN: 'YOUR_BOT_TOKEN',
            USE_POLLING: true,
            CHAT_ID: 'YOUR_CHAT_ID',
          },
        },
        ai: {
          PROVIDER: 'ollama',
          BASE_URL: 'http://localhost:11434',
          API_TOKEN: '',
          MODEL: 'gemma4:e4b',
        },
        personal_information: {
          HUMAN_NAME: 'John Doe',
          HUMAN_GENDER: 'male',
          HUMAN_BIRTHDAY: '1990-01-01',
          HUMAN_LOCATION: 'New York, USA',
          HUMAN_OCCUPATION: 'Software Engineer',
        },
      },
    })).toEqual({
      TEMP_FOLDER: './temp',
      channels: {
        telegram: {
          ENABLED: true,
          CHAT_ID: '',
          USE_POLLING: true,
          BOT_TOKEN: '123456:token',
        },
        discord: {
          ENABLED: true,
        },
      },
      ai: {
        PROVIDER: 'openai',
        BASE_URL: 'https://api.openai.com/v1',
        API_TOKEN: 'secret-token',
        MODEL: 'gemma4:e4b',
      },
      personal_information: {
        HUMAN_NAME: 'Joe Doe',
        HUMAN_GENDER: 'male',
      },
    });
  });

  it('resolves the draft path to apps/client from the monorepo root', () => {
    const repoRoot = createTempDir();
    const appRoot = join(repoRoot, 'apps', 'client');
    const runtimeDir = join(appRoot, 'dist', 'src');

    mkdirSync(join(appRoot, 'src'), { recursive: true });
    writeFileSync(join(appRoot, 'src', 'onboard.ts'), '');

    expect(resolveOnboardingSettingsPath({
      cwd: repoRoot,
      dirname: runtimeDir,
    })).toBe(join(appRoot, SETTINGS_FILENAME));
  });

  it('saves the draft next to settings.json using settings.example.json as the base', () => {
    const repoRoot = createTempDir();
    const appRoot = join(repoRoot, 'apps', 'client');
    const runtimeDir = join(appRoot, 'dist', 'src');

    mkdirSync(appRoot, { recursive: true });
    writeFileSync(join(appRoot, 'settings.json'), '{}');
    writeFileSync(join(appRoot, 'settings.example.json'), JSON.stringify({
      TEMP_FOLDER: './temp',
      heartbeat: {
        ENABLED: true,
      },
      channels: {
        telegram: {
          ENABLED: true,
          BOT_TOKEN: 'YOUR_BOT_TOKEN',
          USE_POLLING: true,
          CHAT_ID: 'YOUR_CHAT_ID',
        },
      },
      ai: {
        PROVIDER: 'ollama',
        BASE_URL: 'http://localhost:11434',
        API_TOKEN: '',
        MODEL: 'gemma4:e4b',
      },
      personal_information: {
        HUMAN_NAME: 'John Doe',
        HUMAN_GENDER: 'male',
        HUMAN_BIRTHDAY: '1990-01-01',
        HUMAN_LOCATION: 'New York, USA',
        HUMAN_OCCUPATION: 'Software Engineer',
      },
    }));

    const destination = saveOnboardingSettings({
      channels: ['telegram'],
      telegramToken: '123456:token',
      provider: 'ollama',
      providerApiToken: '',
    }, {
      cwd: repoRoot,
      dirname: runtimeDir,
    });

    expect(destination).toBe(join(appRoot, SETTINGS_FILENAME));
    expect(JSON.parse(readFileSync(destination, 'utf-8'))).toEqual({
      TEMP_FOLDER: './temp',
      heartbeat: {
        ENABLED: true,
      },
      channels: {
        telegram: {
          ENABLED: true,
          CHAT_ID: '',
          USE_POLLING: true,
          BOT_TOKEN: '123456:token',
        },
      },
      ai: {
        PROVIDER: 'ollama',
        BASE_URL: 'http://localhost:11434',
        API_TOKEN: '',
        MODEL: 'gemma4:e4b',
      },
      personal_information: {
      },
    });
  });
});
