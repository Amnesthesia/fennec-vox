import OpenAI from 'openai';
import { splitIntoChunks, sleep } from './text';
import { pLimit } from './pLimit';
import type { TtsVoice, TtsFormat, TtsModel } from './types';

export interface ChunkCache {
  get(key: string): Promise<Buffer | null>;
  set(key: string, data: Buffer): Promise<void>;
}

const TTS_MAX_CHARS = 4000;

export async function synthesiseText(
  openai: OpenAI,
  text: string,
  voice: TtsVoice,
  format: TtsFormat,
  ttsModel: TtsModel,
  concurrency: number,
  chunkKey: (i: number) => string,
  cache: ChunkCache | null,
  onChunk?: (i: number, total: number, cached: boolean) => void,
  instructions?: string,
): Promise<Buffer> {
  const chunks = splitIntoChunks(text, TTS_MAX_CHARS);
  const buffers = await pLimit(chunks.map((chunk, i) => async () => {
    const key = chunkKey(i);
    if (cache) {
      const cached = await cache.get(key);
      if (cached) {
        onChunk?.(i, chunks.length, true);
        return cached;
      }
    }
    onChunk?.(i, chunks.length, false);
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const params = {
          model: ttsModel, voice, input: chunk, response_format: format,
        } as Parameters<typeof openai.audio.speech.create>[0];
        if (instructions) (params as unknown as Record<string, unknown>)['instructions'] = instructions;
        const response = await openai.audio.speech.create(params);
        const buf = Buffer.from(await response.arrayBuffer());
        await cache?.set(key, buf);
        return buf;
      } catch (e) {
        lastError = e;
        if (attempt < 3) await sleep(2000 * attempt);
      }
    }
    throw lastError;
  }), concurrency);
  return Buffer.concat(buffers);
}
