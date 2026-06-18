import { Buffer } from "buffer";
import { pLimit } from "./pLimit";
import { sleep, splitIntoChunks } from "./text";
import type { ChunkCache } from "./tts";

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const GEMINI_TTS_MODEL = "gemini-2.5-flash-preview-tts";
const GEMINI_MARKUP_MODEL = "gemini-2.5-flash";
// Gemini TTS PCM output: 24kHz, 16-bit mono
const GEMINI_SAMPLE_RATE = 24000;
const GEMINI_CHANNELS = 1;
const GEMINI_BITS = 16;
// Conservative chunk size (chars) for Gemini TTS requests
const GEMINI_MAX_CHARS = 5000;

// Strip the WAV header and return raw PCM bytes.
// Locates the "data" chunk to be safe rather than assuming fixed 44-byte header.
function stripWavHeader(buf: Buffer): Buffer {
	const dataIdx = buf.indexOf(Buffer.from("data"));
	if (dataIdx === -1) return buf;
	return buf.slice(dataIdx + 8);
}

// Build a minimal 44-byte WAV header for raw PCM at Gemini's output params.
function buildWavHeader(dataLen: number): Buffer {
	const byteRate = (GEMINI_SAMPLE_RATE * GEMINI_CHANNELS * GEMINI_BITS) / 8;
	const blockAlign = (GEMINI_CHANNELS * GEMINI_BITS) / 8;
	const h = Buffer.alloc(44);
	h.write("RIFF", 0);
	h.writeUInt32LE(36 + dataLen, 4);
	h.write("WAVE", 8);
	h.write("fmt ", 12);
	h.writeUInt32LE(16, 16);
	h.writeUInt16LE(1, 20); // PCM
	h.writeUInt16LE(GEMINI_CHANNELS, 22);
	h.writeUInt32LE(GEMINI_SAMPLE_RATE, 24);
	h.writeUInt32LE(byteRate, 28);
	h.writeUInt16LE(blockAlign, 32);
	h.writeUInt16LE(GEMINI_BITS, 34);
	h.write("data", 36);
	h.writeUInt32LE(dataLen, 40);
	return h;
}

// Concatenate multiple WAV buffers into a single valid WAV by stripping
// individual headers and building one combined header. Works in both Node
// and browser contexts (no ffmpeg needed for chapter-level concatenation).
export function concatWavBuffers(buffers: Buffer[]): Buffer {
	const pcmParts = buffers.map(stripWavHeader);
	const pcm = Buffer.concat(pcmParts);
	return Buffer.concat([buildWavHeader(pcm.length), pcm]);
}

export async function synthesiseTextGemini(
	apiKey: string,
	text: string,
	voiceName: string,
	concurrency: number,
	chunkKey: (i: number) => string,
	cache: ChunkCache | null,
	onChunk?: (i: number, total: number, cached: boolean) => void,
): Promise<Buffer> {
	// Strip any SSML break tags (added by narrator markup for Cloud TTS) — Gemini uses plain text
	const plainText = text
		.replace(/<break\s+time="[\d.]+s"\s*\/>/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	const chunks = splitIntoChunks(plainText, GEMINI_MAX_CHARS);

	const wavBuffers = await pLimit(
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
						`${GEMINI_API_BASE}/models/${GEMINI_TTS_MODEL}:generateContent?key=${apiKey}`,
						{
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({
								contents: [{ parts: [{ text: chunk }], role: "user" }],
								generationConfig: {
									responseModalities: ["AUDIO"],
									speechConfig: {
										voiceConfig: { prebuiltVoiceConfig: { voiceName } },
									},
								},
							}),
						},
					);
					if (!res.ok) {
						const body = await res.text().catch(() => "");
						throw new Error(
							`Gemini TTS request failed (${res.status}): ${body || res.statusText}`,
						);
					}
					const json = (await res.json()) as {
						candidates: Array<{
							content: {
								parts: Array<{
									inlineData: { mimeType: string; data: string };
								}>;
							};
						}>;
					};
					const inlineData = json.candidates[0]?.content?.parts[0]?.inlineData;
					if (!inlineData)
						throw new Error("No audio data in Gemini TTS response");
					const wavBuf = Buffer.from(inlineData.data, "base64");
					await cache?.set(key, wavBuf);
					return wavBuf;
				} catch (e) {
					lastError = e;
					if (attempt < 3) await sleep(2000 * attempt);
				}
			}
			throw lastError;
		}),
		concurrency,
	);

	return concatWavBuffers(wavBuffers);
}

export async function addNarratorMarkupGemini(
	apiKey: string,
	text: string,
	chunkSize: number,
	concurrency: number,
	systemPrompt: string,
): Promise<string> {
	const rawChunks = splitIntoChunks(text, chunkSize);
	const marked = await pLimit(
		rawChunks.map((chunk) => async () => {
			let lastError: unknown;
			for (let attempt = 1; attempt <= 3; attempt++) {
				try {
					const res = await fetch(
						`${GEMINI_API_BASE}/models/${GEMINI_MARKUP_MODEL}:generateContent?key=${apiKey}`,
						{
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({
								system_instruction: { parts: [{ text: systemPrompt }] },
								contents: [{ role: "user", parts: [{ text: chunk }] }],
								generationConfig: { temperature: 0.1 },
							}),
						},
					);
					if (!res.ok) {
						const body = await res.text().catch(() => "");
						throw new Error(
							`Gemini markup request failed (${res.status}): ${body || res.statusText}`,
						);
					}
					const json = (await res.json()) as {
						candidates: Array<{
							content: { parts: Array<{ text: string }> };
						}>;
					};
					const content = json.candidates[0]?.content?.parts[0]?.text;
					if (!content) throw new Error("Empty response from Gemini markup");
					return content;
				} catch (e) {
					lastError = e;
					if (attempt < 3) await sleep(1000 * attempt);
				}
			}
			throw lastError;
		}),
		concurrency,
	);
	return marked.join("\n\n");
}
