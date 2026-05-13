import { ILogger } from "../../../infrastructure/logger";
import { readFile } from 'fs/promises';
import { join, resolve, sep } from 'node:path';
import { ToolCall, ToolResult } from "../../../types/tools";
import { config } from "../../../config";
import matter from 'gray-matter';

const BASE_SKILLS_DIR = resolve(config.BASE_DIR, 'skills');

export async function executeGetSkill(
  logger: ILogger,
  args: ToolCall['arguments']
): Promise<ToolResult> {

  if (!args.skill_name) {
    logger.error('skill_name is required.');
    throw new Error('skill_name is required.');
  }

  const requestedPath = resolve(BASE_SKILLS_DIR, String(args.skill_name));

  logger.info('get_skill args: ', { skillName: args.skill_name, skillPath: requestedPath });

  const isSafePath = requestedPath === BASE_SKILLS_DIR || requestedPath.startsWith(BASE_SKILLS_DIR + sep);

  if (!isSafePath) {
    logger.error('Path traversal attempt detected.', { requestedPath, skillPath: args.skill_path });
    throw new Error('Invalid skill_path: Access denied.');
  }

  const targetFile = join(requestedPath, 'SKILL.md');
  const content = await readFile(targetFile, 'utf-8');
  const parsed = matter(content);
  const onlyContent = parsed.content || content;

  return {
    toolName: 'get_skill',
    success: true,
    result: onlyContent.slice(0, 20000),
  };
}