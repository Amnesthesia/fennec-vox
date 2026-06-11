import { describe, it, expect, vi, beforeEach } from 'vitest';
import type OpenAI from 'openai';
import { synthesiseText } from '../tts';
import type { ChunkCache } from '../tts';

// Make sleep a no-op so retry tests don't wait 2s + 4s in real time
vi.mock('../text', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../text')>();
  return { ...mod, sleep: vi.fn().mockResolvedValue(undefined) };
});

const voice = 'alloy' as const;
const format = 'mp3' as const;
const model  = 'tts-1' as const;

function makeOpenai(buf: Buffer) {
  return {
    audio: {
      speech: {
        create: vi.fn().mockResolvedValue({
          arrayBuffer: () => Promise.resolve(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)),
        }),
      },
    },
  } as unknown as OpenAI;
}

describe('synthesiseText', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns audio for a short text', async () => {
    const buf = Buffer.from('audio data');
    const openai = makeOpenai(buf);
    const result = await synthesiseText(openai, 'Hello world.', voice, format, model, 1, i => `chunk-${i}`, null);
    expect(result.length).toBeGreaterThan(0);
    expect(openai.audio.speech.create).toHaveBeenCalledOnce();
  });

  it('reads from cache and skips API call', async () => {
    const cached = Buffer.from('cached audio');
    const cache: ChunkCache = {
      get: vi.fn().mockResolvedValue(cached),
      set: vi.fn(),
    };
    const openai = makeOpenai(Buffer.from('should not be called'));

    const result = await synthesiseText(openai, 'Hello.', voice, format, model, 1, i => `key-${i}`, cache);
    expect(result).toEqual(cached);
    expect(cache.get).toHaveBeenCalledOnce();
    expect(openai.audio.speech.create).not.toHaveBeenCalled();
  });

  it('writes to cache after API call', async () => {
    const audio = Buffer.from('fresh audio');
    const cache: ChunkCache = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn(),
    };
    const openai = makeOpenai(audio);

    await synthesiseText(openai, 'Hello.', voice, format, model, 1, i => `key-${i}`, cache);
    expect(cache.set).toHaveBeenCalledOnce();
  });

  it('retries up to 3 times on failure then throws', async () => {
    const mockCreate = vi.fn().mockRejectedValue(new Error('TTS API error'));
    const openai = { audio: { speech: { create: mockCreate } } } as unknown as OpenAI;

    await expect(
      synthesiseText(openai, 'hello', voice, format, model, 1, i => `k${i}`, null),
    ).rejects.toThrow('TTS API error');
    expect(mockCreate).toHaveBeenCalledTimes(3);
  });

  it('concatenates multiple chunks', async () => {
    // Text > 4000 chars forces chunking
    const longText = 'Word '.repeat(900).trim();  // ~4500 chars
    const chunkBuf = Buffer.from([1, 2, 3]);
    const openai = makeOpenai(chunkBuf);
    const result = await synthesiseText(openai, longText, voice, format, model, 2, i => `c${i}`, null);
    // Two chunks → two API calls → concatenated result is 6 bytes
    expect(openai.audio.speech.create).toHaveBeenCalledTimes(2);
    expect(result.length).toBe(6);
  });

  it('invokes onChunk callback', async () => {
    const onChunk = vi.fn();
    const openai = makeOpenai(Buffer.from('x'));
    await synthesiseText(openai, 'Short.', voice, format, model, 1, i => `k${i}`, null, onChunk);
    expect(onChunk).toHaveBeenCalledWith(0, 1, false);
  });
});
