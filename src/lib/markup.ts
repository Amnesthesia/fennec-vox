import type Anthropic from "@anthropic-ai/sdk";
import type OpenAI from "openai";
import { pLimit } from "./pLimit";
import { sleep, splitIntoChunks } from "./text";
import type {
	Chapter,
	ChapterRecord,
	CostEstimate,
	MarkupProvider,
	TtsModel,
} from "./types";

export const NARRATOR_SYSTEM = `You are a professional audiobook narrator assistant. Reformat the text below to read naturally aloud.
Rules:
- Do NOT change, add, or remove any words
- Add an em dash (—) where a narrator would pause briefly: after dialogue attributions, before scene shifts, at strong rhetorical breaks
- Add ellipsis (...) where a longer dramatic pause belongs: end of a tense sentence, after a revelation, trailing thoughts
- Preserve all paragraph breaks exactly
- Return ONLY the reformatted text with no preamble or explanation`;

async function addNarratorMarkupClaude(
	anthropic: Anthropic,
	text: string,
	chunkSize: number,
	concurrency: number,
): Promise<string> {
	const rawChunks = splitIntoChunks(text, chunkSize);
	const marked = await pLimit(
		rawChunks.map((chunk) => async () => {
			const maxTokens = Math.min(4096, Math.ceil(chunk.length * 1.2) + 256);
			let lastError: unknown;
			for (let attempt = 1; attempt <= 3; attempt++) {
				try {
					const response = await anthropic.messages.create({
						model: "claude-haiku-4-5-20251001",
						max_tokens: maxTokens,
						system: NARRATOR_SYSTEM,
						messages: [{ role: "user", content: chunk }],
					});
					const block = response.content[0];
					if (block?.type !== "text")
						throw new Error("Unexpected response type from Claude");
					return block.text;
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

async function addNarratorMarkupGpt(
	openai: OpenAI,
	text: string,
	chunkSize: number,
	concurrency: number,
): Promise<string> {
	const rawChunks = splitIntoChunks(text, chunkSize);
	const marked = await pLimit(
		rawChunks.map((chunk) => async () => {
			let lastError: unknown;
			for (let attempt = 1; attempt <= 3; attempt++) {
				try {
					const response = await openai.chat.completions.create({
						model: "gpt-4o-mini",
						messages: [
							{ role: "system", content: NARRATOR_SYSTEM },
							{ role: "user", content: chunk },
						],
					});
					const content = response.choices[0]?.message?.content;
					if (!content) throw new Error("Empty response from GPT-4o mini");
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

export async function addNarratorMarkup(
	provider: MarkupProvider,
	anthropic: Anthropic | null,
	openai: OpenAI,
	text: string,
	chunkSize: number,
	concurrency: number,
): Promise<string> {
	if (provider === "claude-haiku") {
		if (!anthropic)
			throw new Error("Anthropic client required for claude-haiku provider");
		return addNarratorMarkupClaude(anthropic, text, chunkSize, concurrency);
	}
	return addNarratorMarkupGpt(openai, text, chunkSize, concurrency);
}

export function detectMarkupProvider(
	anthropicKey: string | undefined,
	openaiKey: string | undefined,
): MarkupProvider {
	if (!openaiKey) {
		throw new Error(
			"OPENAI_API_KEY is required (used for TTS and as fallback markup model). " +
				"Set it and optionally set ANTHROPIC_API_KEY to use Claude Haiku for markup.",
		);
	}
	return anthropicKey ? "claude-haiku" : "gpt-4o-mini";
}

const PRICING = {
	claudeHaikuInputPerMTok: 0.8,
	claudeHaikuOutputPerMTok: 4.0,
	gpt4oMiniInputPerMTok: 0.15,
	gpt4oMiniOutputPerMTok: 0.6,
	tts1PerMChars: 15.0,
	tts1HdPerMChars: 30.0,
} as const;

const CHARS_PER_TOKEN = 4;
const SSML_OUTPUT_RATIO = 1.35;
const SSML_SYSTEM_TOKENS = 120;

export function estimateCosts(
	chapters: Chapter[],
	completedChapters: Record<number, ChapterRecord>,
	chunkSize: number,
	ttsModel: TtsModel,
	provider: MarkupProvider,
): CostEstimate {
	let pendingChapters = 0,
		totalInputChars = 0,
		totalOutputChars = 0,
		totalTtsChars = 0;
	for (const ch of chapters) {
		if (completedChapters[ch.index]) continue;
		pendingChapters++;
		totalInputChars += ch.text.length;
		totalOutputChars += Math.ceil(ch.text.length * SSML_OUTPUT_RATIO);
		totalTtsChars += Math.ceil(ch.text.length * 0.9);
	}
	const numChunks = Math.ceil(totalInputChars / chunkSize);
	const inputTokens =
		Math.ceil(totalInputChars / CHARS_PER_TOKEN) +
		numChunks * SSML_SYSTEM_TOKENS;
	const outputTokens = Math.ceil(totalOutputChars / CHARS_PER_TOKEN);
	const markupInputRate =
		provider === "claude-haiku"
			? PRICING.claudeHaikuInputPerMTok
			: PRICING.gpt4oMiniInputPerMTok;
	const markupOutputRate =
		provider === "claude-haiku"
			? PRICING.claudeHaikuOutputPerMTok
			: PRICING.gpt4oMiniOutputPerMTok;
	const claudeCost =
		(inputTokens / 1_000_000) * markupInputRate +
		(outputTokens / 1_000_000) * markupOutputRate;
	const ttsRate =
		ttsModel === "tts-1-hd" ? PRICING.tts1HdPerMChars : PRICING.tts1PerMChars;
	const ttsCost = (totalTtsChars / 1_000_000) * ttsRate;
	return {
		pendingChapters,
		skippedChapters: chapters.length - pendingChapters,
		totalInputChars,
		inputTokens,
		outputTokens,
		totalTtsChars,
		claudeCost,
		ttsCost,
		totalCost: claudeCost + ttsCost,
		provider,
	};
}
