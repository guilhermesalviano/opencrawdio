import { describe, it, expect, vi } from 'vitest';
import { MessageRepository } from '../../../src/repositories/message';

function makeDb(rows: any[] = []) {
  return {
    query: vi.fn().mockReturnValue(rows),
    run: vi.fn(),
  };
}

describe('MessageRepository', () => {
  it('fetches the latest N messages while returning them in chronological order', () => {
    const db = makeDb([
      {
        id: 'm2',
        session_id: 'sess-1',
        role: 'assistant',
        content: 'second',
        created_at: '2026-05-01T12:00:01.000Z',
      },
      {
        id: 'm3',
        session_id: 'sess-1',
        role: 'user',
        content: 'third',
        created_at: '2026-05-01T12:00:02.000Z',
      },
    ]);
    const repository = new MessageRepository(db as any);

    const messages = repository.getBySessionId('sess-1', 2);

    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toContain('ORDER BY created_at DESC');
    expect(sql).toContain('LIMIT ?');
    expect(sql).toContain('ORDER BY created_at ASC');
    expect(params).toEqual(['sess-1', 2]);
    expect(messages.map((message) => message.id)).toEqual(['m2', 'm3']);
  });

  it('uses the default limit when no limit is provided', () => {
    const db = makeDb([]);
    const repository = new MessageRepository(db as any);

    repository.getBySessionId('sess-1');

    const [, params] = db.query.mock.calls[0];
    expect(params).toEqual(['sess-1', 15]);
  });
});
