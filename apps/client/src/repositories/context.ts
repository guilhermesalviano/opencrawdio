import os from 'node:os';
import { config } from '../config';

export interface PersonalInformation {
  name?: string;
  gender?: string;
  birthday?: string;
  location?: string;
  occupation?: string;
}

export interface SystemInfo {
  source: string;
  platform: string;
  datetime: string;
}

interface IContextRepository {
  get(params: { channel: string }): string;
}

class ContextRepository implements IContextRepository {

  /**
   * Load and format system info in one call (convenience method)
   */
  get(params: { channel: string }): string {
    const systemInfo = this.getSystemInfo(params);
    const personalInfo = this.getPersonalInfo(config.PERSONAL_INFORMATION);
    return this.formatAsPrompt(systemInfo, personalInfo);
  }

  /**
   * Collect current system information
   */
  private getSystemInfo(params: { channel: string }): SystemInfo {
    return {
      source: params.channel,
      platform: os.platform(),
      datetime: new Date().toISOString(),
    };
  }

  private getPersonalInfo(params: any): PersonalInformation {
    return {
      name: params.NAME,
      gender: params.GENDER,
      birthday: params.BIRTHDAY,
      location: params.LOCATION,
      occupation: params.OCCUPATION,
    };
  }

  /**
   * Format system info as prompt text
   * inactivated temporarily
   */
  private formatAsPrompt(system: SystemInfo, personal: PersonalInformation): string {
    return [
      '[Session Context]',
      system.source ? `- Channel Source: ${system.source}` : null,
      system.datetime ? `- Datetime: ${system.datetime}` : null,
      personal.name ? `- User name: ${personal.name}` : null,
      personal.gender ? `- User gender: ${personal.gender}` : null,
      personal.birthday ? `- User birthday: ${personal.birthday}` : null,
      personal.location ? `- User location: ${personal.location}` : null,
      personal.occupation ? `- User occupation: ${personal.occupation}` : null,
      'Please use the session context above to compose your response if needed.',
    ].join('\n');
  }
}

class ContextRepositoryFactory {
  static create(): IContextRepository {
    return new ContextRepository();
  }
}

export { IContextRepository, ContextRepository, ContextRepositoryFactory };