import { describe, it, expect, vi, beforeEach } from 'vitest';
import { detectMarkupProvider, estimateCosts, addNarratorMarkup } from '../markup';
import type { Chapter, ChapterRecord } from '../types';

describe('detectMarkupProvider', () => {
  it('throws when OpenAI key is missing', () => {
    expect(() => detectMarkupProvider(undefined, undefined)).toThrow('OPENAI_API_KEY is required');
    expect(() => detectMarkupProvider('ant-key', undefined)).toThrow('OPENAI_API_KEY is required');
  });

  it('returns claude-haiku when both keys are present', () => {
    expect(detectMarkupProvider('ant-key', 'sk-oai')).toBe('claude-haiku');
  });

  it('returns gpt-4o-mini when only OpenAI key is present', () => {
    expect(detectMarkupProvider(undefined, 'sk-oai')).toBe('gpt-4o-mini');
    expect(detectMarkupProvider('', 'sk-oai')).toBe('gpt-4o-mini');
  });
});

describe('estimateCosts', () => {
  const makeChapter = (index: number, length: number): Chapter => ({
    index, spineIndex: index, id: `ch-${index}`,
    title: `Chapter ${index}`,
    text: 'x'.repeat(length),
  });

  it('returns zero cost when all chapters are already completed', () => {
    const chapters = [makeChapter(0, 1000)];
    const completed: Record<number, ChapterRecord> = {
      0: { title: 'Ch 0', file: 'x', chars: 1000, audioBytes: 0, completedAt: '' },
    };
    const result = estimateCosts(chapters, completed, 2000, 'gpt-4o-mini-tts', 'gpt-4o-mini');
    expect(result.pendingChapters).toBe(0);
    expect(result.totalCost).toBe(0);
  });

  it('counts pending chapters correctly', () => {
    const chapters = [makeChapter(0, 1000), makeChapter(1, 1000), makeChapter(2, 1000)];
    const completed: Record<number, ChapterRecord> = {
      0: { title: '', file: '', chars: 0, audioBytes: 0, completedAt: '' },
    };
    const result = estimateCosts(chapters, completed, 2000, 'tts-1', 'gpt-4o-mini');
    expect(result.pendingChapters).toBe(2);
    expect(result.skippedChapters).toBe(1);
  });

  it('uses higher per-char rate for tts-1-hd', () => {
    const chapters = [makeChapter(0, 10_000)];
    const hdCost  = estimateCosts(chapters, {}, 2000, 'tts-1-hd', 'gpt-4o-mini').ttsCost;
    const stdCost = estimateCosts(chapters, {}, 2000, 'tts-1',    'gpt-4o-mini').ttsCost;
    expect(hdCost).toBe(stdCost * 2);
  });

  it('uses lower markup cost for gpt-4o-mini vs claude-haiku', () => {
    const chapters = [makeChapter(0, 10_000)];
    const gptCost    = estimateCosts(chapters, {}, 2000, 'tts-1', 'gpt-4o-mini').claudeCost;
    const claudeCost = estimateCosts(chapters, {}, 2000, 'tts-1', 'claude-haiku').claudeCost;
    expect(claudeCost).toBeGreaterThan(gptCost);
  });
});

describe('addNarratorMarkup', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('calls Claude when provider is claude-haiku', async () => {
    const mockCreate = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'marked text' }],
    });
    const mockAnthropic = { messages: { create: mockCreate } } as unknown as import('@anthropic-ai/sdk').default;
    const mockOpenai    = {} as unknown as import('openai').default;

    const result = await addNarratorMarkup('claude-haiku', mockAnthropic, mockOpenai, 'hello', 2000, 1);
    expect(mockCreate).toHaveBeenCalledOnce();
    expect(result).toBe('marked text');
  });

  it('calls GPT when provider is gpt-4o-mini', async () => {
    const mockCreate = vi.fn().mockResolvedValue({
      choices: [{ message: { content: 'gpt marked' } }],
    });
    const mockOpenai  = { chat: { completions: { create: mockCreate } } } as unknown as import('openai').default;
    const mockAnthropic = null;

    const result = await addNarratorMarkup('gpt-4o-mini', mockAnthropic, mockOpenai, 'hello', 2000, 1);
    expect(mockCreate).toHaveBeenCalledOnce();
    expect(result).toBe('gpt marked');
  });

  it('throws if claude-haiku requested but anthropic client is null', async () => {
    await expect(
      addNarratorMarkup('claude-haiku', null, {} as never, 'hello', 2000, 1),
    ).rejects.toThrow('Anthropic client required');
  });

  it('retries on failure and eventually throws', async () => {
    const mockCreate = vi.fn().mockRejectedValue(new Error('network error'));
    const mockOpenai = { chat: { completions: { create: mockCreate } } } as never;

    await expect(
      addNarratorMarkup('gpt-4o-mini', null, mockOpenai, 'hello', 2000, 1),
    ).rejects.toThrow('network error');
    expect(mockCreate).toHaveBeenCalledTimes(3);
  });

  it('joins multi-chunk results with double newline', async () => {
    const mockCreate = vi.fn().mockResolvedValue({ choices: [{ message: { content: 'marked' } }] });
    const mockOpenai = { chat: { completions: { create: mockCreate } } } as never;

    // Two paragraphs with chunkSize=50 forces at least 2 chunks
    const text = 'First para text.\n\n' + 'Second para text.'.padEnd(60, ' extra words');
    const result = await addNarratorMarkup('gpt-4o-mini', null, mockOpenai, text, 50, 1);
    expect(mockCreate.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(result).toContain('marked');
  });
});
