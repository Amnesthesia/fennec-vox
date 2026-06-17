import { Buffer } from "buffer";
import { pLimit } from "./pLimit";
import { sleep, splitIntoChunks } from "./text";
import type { ChunkCache } from "./tts";
import type { ElevenLabsModel, TtsFormat } from "./types";

const ELEVENLABS_API_BASE = "https://api.elevenlabs.io/v1";
// Conservative chunk size that stays safely under every current model's
// per-request character limit, including eleven_v3's.
const ELEVENLABS_MAX_CHARS = 2500;

export function elevenLabsOutputFormat(format: TtsFormat): string {
	return format === "opus" ? "opus_48000_128" : "mp3_44100_128";
}

export async function synthesiseTextElevenLabs(
	apiKey: string,
	text: string,
	voiceId: string,
	format: TtsFormat,
	ttsModel: ElevenLabsModel,
	concurrency: number,
	chunkKey: (i: number) => string,
	cache: ChunkCache | null,
	onChunk?: (i: number, total: number, cached: boolean) => void,
): Promise<Buffer> {
	const chunks = splitIntoChunks(text, ELEVENLABS_MAX_CHARS);
	const outputFormat = elevenLabsOutputFormat(format);
	const buffers = await pLimit(
		chunks.map((chunk, i) => async () => {
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
					const res = await fetch(
						`${ELEVENLABS_API_BASE}/text-to-speech/${voiceId}?output_format=${outputFormat}`,
						{
							method: "POST",
							headers: {
								"xi-api-key": apiKey,
								"Content-Type": "application/json",
							},
							body: JSON.stringify({ text: chunk, model_id: ttsModel }),
						},
					);
					if (!res.ok) {
						const body = await res.text().catch(() => "");
						throw new Error(
							`ElevenLabs TTS request failed (${res.status}): ${body || res.statusText}`,
						);
					}
					const buf = Buffer.from(await res.arrayBuffer());
					await cache?.set(key, buf);
					return buf;
				} catch (e) {
					lastError = e;
					if (attempt < 3) await sleep(2000 * attempt);
				}
			}
			throw lastError;
		}),
		concurrency,
	);
	return Buffer.concat(buffers);
}
