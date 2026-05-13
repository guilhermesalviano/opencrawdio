import { readdirSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { ILogger } from '../infrastructure/logger';
import matter from 'gray-matter';
import { config } from '../config';
import { Skill } from '../types/skills';

interface ISkillsRepository {
  get(): Skill[];
  findByName(params: { name: string }): Skill | null;
}

class SkillsRepository {
  private readonly logger: ILogger;

  constructor(logger: ILogger) {
    this.logger = logger;
  }

  get(): Skill[] {
    const skillsPath = join(config.BASE_DIR, 'skills');
    if (!existsSync(skillsPath)) return [];

    return readdirSync(skillsPath, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => {
        const skillFile = join(skillsPath, entry.name, 'SKILL.md');

        if (!existsSync(skillFile)) return this.helperWarnAndReturn(this.logger, `Skill folder found but SKILL.md missing: ${entry.name}`);

        const raw = readFileSync(skillFile, 'utf-8');
        const { data } = matter(raw);

        const skill: Skill = {
          name: data.name ?? entry.name,
          description: data.description ?? '',
          read_when: data.read_when ?? null,
        };

        return skill;
      })
      .filter((skill): skill is Skill => skill !== null);
  }

  findByName(params: { name: string }): Skill | null {
    const skillsPath = join(config.BASE_DIR, 'skills');
    if (!existsSync(skillsPath)) return this.helperWarnAndReturn(this.logger, `Skill path not found.`);

    const entry = readdirSync(skillsPath, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .find(entry => entry.name === params.name);

    if (!entry) return this.helperWarnAndReturn(this.logger, `Skill not found: ${params.name}`);

    const skillFile = join(skillsPath, entry.name, 'SKILL.md');

    if (!existsSync(skillFile)) return this.helperWarnAndReturn(this.logger, `Skill folder found but SKILL.md missing: ${params.name}`);

    const raw = readFileSync(skillFile, 'utf-8');
    const { data, content } = matter(raw);

    return {
      name: data.name ?? entry.name,
      description: data.description ?? '',
      read_when: data.read_when ?? null,
      content,
    };
  }

  helperWarnAndReturn(logger: ILogger, message: string) {
    logger.warn(message);
    return null;
  }
}

class SkillsRepositoryFactory {
  static create(logger: ILogger): ISkillsRepository {
    return new SkillsRepository(logger);
  }
}

export { ISkillsRepository, SkillsRepository, SkillsRepositoryFactory };