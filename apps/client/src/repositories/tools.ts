import type { AIToolDefinition } from '../types/provider';
import { Skill } from '../types/skills';

interface GetAllOptions {
  includeTaskTools?: boolean;
}

interface IToolsRepository {
  getAll(options?: GetAllOptions): AIToolDefinition[];
}

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH'] as const;

class ToolsRepository implements IToolsRepository {

  constructor(private skills: Skill[]) {}

  getAll(options?: GetAllOptions): AIToolDefinition[] {
    const tools: AIToolDefinition[] = [];
    const includeTaskTools = options?.includeTaskTools ?? true;

    tools.push(this.curlTool());
    if (this.skills?.length > 0) tools.push(this.getSkillTool(this.skills));
    
    if (includeTaskTools) {
      tools.push(this.createTaskTool());
      tools.push(this.listTasksTool());
      tools.push(this.updateTaskTool());
      tools.push(this.deleteTaskTool());
    }

    return tools;
  }

  private getSkillTool(skills: Skill[]): AIToolDefinition {
    return {
      type: 'function',
      function: {
        name: 'get_skill',
        description: `Read the complete SKILL.md documentation for a skill before executing any task that skill covers.
  Call this whenever you need implementation details, constraints, or required patterns for a task.
  <available_skills>${skills.map(s => `<skill><skill_name>${s.name}</skill_name><skill_description>${s.description}</skill_description></skill>`).join('')}</available_skills>`,
        parameters: {
          type: 'object',
          properties: {
            skill_name: {
              type: 'string',
              enum: skills.map(s => s.name),
              description: 'The skill to read documentation for.',
            },
          },
          required: ['skill_name'],
        },
      },
    };
  }

  private curlTool(): AIToolDefinition {
    return {
      type: 'function',
      function: {
        name: 'curl_request',
        description:
          'Execute HTTP requests using curl. Use only parameters explicitly required by the selected skill. Do not invent extra shell transformations.',
        parameters: {
          type: 'object',
          properties: {
            url: {
              type: 'string',
              description: 'URL to request (required). Keep values exactly as required by the skill.',
            },
            method: {
              type: 'string',
              enum: HTTP_METHODS,
              description: 'HTTP method (default: GET)',
            },
            headers: {
              type: 'object',
              description:
                'Custom HTTP headers. Example: {"Authorization": "Bearer token", "Content-Type": "application/json"}',
            },
            data: {
              type: 'string',
              description: 'Request body for POST/PUT/PATCH. Can be JSON string or form data.',
            },
            follow_redirects: {
              type: 'boolean',
              description: 'Follow HTTP redirects (default: true)',
            },
            timeout: {
              type: 'number',
              description: 'Request timeout in seconds (default: 30)',
            },
            pipe: {
              type: 'string',
              description:
                'Optional: pipe the response through a command. Examples: "| jq \'.fact\'", "| grep search_term", "| head -5". Useful for extracting specific data from JSON or text responses.',
            },
          },
          required: ['url'],
        },
      },
    };
  }

  private createTaskTool(): AIToolDefinition {
    return {
      type: 'function',
      function: {
        name: 'set_task',
        description:
          'Save a reminder or scheduled task for the user. DEFAULT BEHAVIOR: always create a one-time task by pinning the exact minute, hour, day-of-month, and month — NEVER use * for day-of-month or month unless the user explicitly asks for a recurring schedule (e.g. "every day", "every Monday", "every month"). Only use wildcard (*) fields when the user clearly requests a recurring pattern.',
        parameters: {
          type: 'object',
          properties: {
            task: {
              type: 'string',
              description: 'Clear description of what the user wants to be reminded about or the task to schedule.',
            },
            type: {
              type: 'string',
              enum: ['reminder', 'scheduled_task'],
              description: 'Type of the task (optional, defaults to "reminder"): "reminder" for one-time or recurring reminders to the user, "scheduled_task" for automated background tasks to be executed by the agent.',
            },
            cron_expression: {
              type: 'string',
              description:
                'Standard 5-field cron expression. Format: "minute hour day-of-month month day-of-week". ' +
                'DEFAULT — one-time: always pin minute, hour, day-of-month and month to specific values (e.g. "30 9 15 6 *" = once on June 15th at 9:30am). ' +
                'ONLY use wildcards (*) when the user explicitly requests recurrence: ' +
                '"0 9 * * *" (every day at 9am), "0 9 * * 1" (every Monday at 9am), "0 8 1 * *" (1st of every month at 8am), "*/30 * * * *" (every 30 min).',
            },
          },
          required: ['task', 'cron_expression'],
        },
      },
    };
  }

  private listTasksTool(): AIToolDefinition {
    return {
      type: 'function',
      function: {
        name: 'list_tasks',
        description: 'List all saved tasks and scheduled tasks. Call this when the user asks to see, check, or review their tasks.',
        parameters: {
          type: 'object',
          properties: {},
          required: [],
        },
      },
    };
  }

  private updateTaskTool(): AIToolDefinition {
    return {
      type: 'function',
      function: {
        name: 'update_task',
        description: 'Update an existing task. Call this when the user wants to change the description, type, or schedule of a task. Use list_tasks first if the ID is not known.',
        parameters: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              description: 'The UUID of the task to update.',
            },
            task: {
              type: 'string',
              description: 'New description for the task (optional).',
            },
            type: {
              type: 'string',
              enum: ['reminder', 'scheduled_task'],
              description: 'New type for the task (optional): "reminder" or "scheduled_task".',
            },
            cron_expression: {
              type: 'string',
              description: 'New 5-field cron expression for the schedule (optional). Examples: "0 9 * * *" (daily at 9am), "0 9 * * 1" (every Monday at 9am).',
            },
          },
          required: ['id'],
        },
      },
    };
  }

  private deleteTaskTool(): AIToolDefinition {
    return {
      type: 'function',
      function: {
        name: 'delete_task',
        description: 'Delete a task by ID. Call this when the user wants to remove or cancel a task. Use list_tasks first if the ID is not known.',
        parameters: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              description: 'The UUID of the task to delete.',
            },
          },
          required: ['id'],
        },
      },
    };
  }
}

class ToolsRepositoryFactory {
  static create(skills: Skill[]): ToolsRepository {
    return new ToolsRepository(skills);
  }
}

export { IToolsRepository, ToolsRepository, ToolsRepositoryFactory };