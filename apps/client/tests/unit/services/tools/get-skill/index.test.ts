import { beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { config } from '../../../../../src/config';
import type { ILogger } from '../../../../../src/infrastructure/logger';

const { mockReadFile } = vi.hoisted(() => ({
  mockReadFile: vi.fn(),
}));

vi.mock('fs/promises', () => ({
  readFile: mockReadFile,
}));

import { executeGetSkill } from '../../../../../src/services/tools/get-skill';

const mockLogger: ILogger = {
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

describe('executeGetSkill', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadFile.mockReset();
  });

  it('throws when skill_name is missing', async () => {
    await expect(
      executeGetSkill(mockLogger, { skill_name: '' }),
    ).rejects.toThrow('skill_name is required.');

    expect(mockLogger.error).toHaveBeenCalledWith('skill_name is required.');
    expect(mockReadFile).not.toHaveBeenCalled();
  });

  it('blocks path traversal attempts', async () => {
    const baseSkills = path.resolve(config.BASE_DIR, 'skills');
    const traversalInput = '../../etc';

    await expect(
      executeGetSkill(mockLogger, { skill_name: traversalInput }),
    ).rejects.toThrow('Invalid skill_path: Access denied.');

    expect(mockLogger.error).toHaveBeenCalledWith(
      'Path traversal attempt detected.',
      expect.objectContaining({
        requestedPath: path.resolve(baseSkills, traversalInput),
      }),
    );
    expect(mockReadFile).not.toHaveBeenCalled();
  });

  it('reads SKILL.md and returns frontmatter content only', async () => {
    const fileText = ['---', 'name: Weather Skill', 'version: 1', '---', '', 'Body content line'].join('\n');
    mockReadFile.mockResolvedValue(fileText);

    const result = await executeGetSkill(mockLogger, {
      skill_name: 'weather',
    });

    expect(result.toolName).toBe('get_skill');
    expect(result.success).toBe(true);
    expect(result.result).toBe('\nBody content line');

    const baseSkills = path.resolve(config.BASE_DIR, 'skills');
    const expectedPath = path.join(baseSkills, 'weather', 'SKILL.md');
    expect(mockReadFile).toHaveBeenCalledWith(expectedPath, 'utf-8');
  });

  it('falls back to raw content when there is no frontmatter', async () => {
    mockReadFile.mockResolvedValue('plain skill content');

    const result = await executeGetSkill(mockLogger, {
      skill_name: 'plain',
    });

    expect(result.success).toBe(true);
    expect(result.result).toBe('plain skill content');
  });

  it('truncates result to 20000 characters', async () => {
    mockReadFile.mockResolvedValue('a'.repeat(21000));

    const result = await executeGetSkill(mockLogger, {
      skill_name: 'big',
    });

    expect((result.result ?? '').length).toBe(20000);
  });
});
