import { Buffer } from "buffer";
import { pLimit } from "./pLimit";
import { sleep, splitIntoChunks } from "./text";
import type { ChunkCache } from "./tts";
import type { TtsFormat } from "./types";

const GOOGLE_API_BASE = "https://texttospeech.googleapis.com/v1";
// Conservative limit under the 5000-byte request ceiling.
const GOOGLE_MAX_CHARS = 4500;
// Google's internal sentence parser rejects sentences longer than ~1000 chars.
const GOOGLE_MAX_SENTENCE_CHARS = 800;

// Breaks text at soft punctuation boundaries so no sentence exceeds
// GOOGLE_MAX_SENTENCE_CHARS. <break> tags are treated as sentence boundaries
// and preserved verbatim. Segments are joined with \n\n so splitIntoChunks
// keeps them separate rather than re-merging them.
function breakLongSentences(text: string): string {
	const BREAK_TAG_RE = /<break\s+time="[\d.]+s"\s*\/>/g;
	const normalized = text.replace(BREAK_TAG_RE, (tag) => `${tag}\n\n`);

	const rawSegments = normalized.split(/(?<=[.!?])\s+/);
	const out: string[] = [];

	for (const seg of rawSegments) {
		if (seg.length <= GOOGLE_MAX_SENTENCE_CHARS) {
			out.push(seg);
			continue;
		}
		const subsegs = seg.split(/(?<=[,;:—])\s+/);
		let acc = "";
		for (const sub of subsegs) {
			if (sub.length > GOOGLE_MAX_SENTENCE_CHARS) {
				if (acc) {
					out.push(acc);
					acc = "";
				}
				let rem = sub;
				while (rem.length > GOOGLE_MAX_SENTENCE_CHARS) {
					const cut = rem.lastIndexOf(" ", GOOGLE_MAX_SENTENCE_CHARS);
					const b = cut > 0 ? cut : GOOGLE_MAX_SENTENCE_CHARS;
					out.push(rem.slice(0, b).trim());
					rem = rem.slice(b).trim();
				}
				acc = rem;
			} else if (acc.length + 1 + sub.length > GOOGLE_MAX_SENTENCE_CHARS) {
				if (acc) out.push(acc);
				acc = sub;
			} else {
				acc = acc ? `${acc} ${sub}` : sub;
			}
		}
		if (acc) out.push(acc);
	}

	return out.join("\n\n");
}

function escapeXml(str: string): string {
	return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Wraps text (which may contain <break time="Xs" /> tags inserted by the
// narrator-markup LLM) in a SSML <speak> block, escaping the surrounding
// plain text while preserving the break tags verbatim.
function toGoogleSsml(text: string): string {
	const BREAK_RE = /<break\s+time="[\d.]+s"\s*\/>/g;
	const parts: string[] = [];
	let lastIndex = 0;
	for (const match of text.matchAll(BREAK_RE)) {
		parts.push(escapeXml(text.slice(lastIndex, match.index ?? 0)), match[0]);
		lastIndex = (match.index ?? 0) + match[0].length;
	}
	parts.push(escapeXml(text.slice(lastIndex)));
	return `<speak>${parts.join("")}</speak>`;
}

// Extracts the BCP-47 language code from a Google voice name
// (e.g. "en-US-Journey-F" → "en-US", "fr-FR-Neural2-A" → "fr-FR").
function languageCodeFromVoice(voiceName: string): string {
	const parts = voiceName.split("-");
	if (parts.length >= 2) return `${parts[0]}-${parts[1]}`;
	return "en-US";
}

export async function synthesiseTextGoogle(
	apiKey: string,
	text: string,
	voiceName: string,
	format: TtsFormat,
	concurrency: number,
	chunkKey: (i: number) => string,
	cache: ChunkCache | null,
	onChunk?: (i: number, total: number, cached: boolean) => void,
): Promise<Buffer> {
	const chunks = splitIntoChunks(breakLongSentences(text), GOOGLE_MAX_CHARS);
	const audioEncoding = format === "opus" ? "OGG_OPUS" : "MP3";
	const languageCode = languageCodeFromVoice(voiceName);

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
			const ssml = toGoogleSsml(chunk);
			let lastError: unknown;
			for (let attempt = 1; attempt <= 3; attempt++) {
				try {
					const res = await fetch(
						`${GOOGLE_API_BASE}/text:synthesize?key=${apiKey}`,
						{
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({
								input: { ssml },
								voice: { languageCode, name: voiceName },
								audioConfig: { audioEncoding },
							}),
						},
					);
					if (!res.ok) {
						const body = await res.text().catch(() => "");
						throw new Error(
							`Google TTS request failed (${res.status}): ${body || res.statusText}`,
						);
					}
					const json = (await res.json()) as { audioContent: string };
					const buf = Buffer.from(json.audioContent, "base64");
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
