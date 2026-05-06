import { describe, it, expect, beforeEach } from 'vitest';
import {
  beginFooterActivity,
  getFooterActivityNote,
  resetFooterActivityStore,
  subscribeToFooterActivity,
} from '../../../src/utils/footer-activity';

describe('footer activity store', () => {
  beforeEach(() => {
    resetFooterActivityStore();
  });

  it('returns an empty note when nothing is active', () => {
    expect(getFooterActivityNote()).toBe('');
  });

  it('tracks a single active activity', () => {
    const end = beginFooterActivity('summarizer');

    expect(getFooterActivityNote()).toBe('background: summarizer');

    end();

    expect(getFooterActivityNote()).toBe('');
  });

  it('keeps the note active until all overlapping runs finish', () => {
    const endFirst = beginFooterActivity('summarizer');
    const endSecond = beginFooterActivity('summarizer');

    endFirst();
    expect(getFooterActivityNote()).toBe('background: summarizer');

    endSecond();
    expect(getFooterActivityNote()).toBe('');
  });

  it('lists active activities in a stable order', () => {
    const endSummarizer = beginFooterActivity('summarizer');
    const endHeartbeat = beginFooterActivity('heartbeat');

    expect(getFooterActivityNote()).toBe('background: heartbeat, summarizer');

    endHeartbeat();
    endSummarizer();
  });

  it('pushes note updates to subscribers immediately and on changes', () => {
    const updates: string[] = [];
    const unsubscribe = subscribeToFooterActivity((note) => {
      updates.push(note);
    });

    const end = beginFooterActivity('heartbeat');
    end();
    unsubscribe();

    expect(updates).toEqual(['', 'background: heartbeat', '']);
  });
});
