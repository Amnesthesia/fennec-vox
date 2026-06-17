import type Anthropic from "@anthropic-ai/sdk";
import type OpenAI from "openai";
import { pLimit } from "./pLimit";
import { sleep, splitIntoChunks } from "./text";
import type {
	BookMetadata,
	Chapter,
	ChapterRecord,
	CostEstimate,
	ElevenLabsModel,
	MarkupProvider,
	TtsModel,
	TtsProvider,
} from "./types";

// Plain punctuation works for OpenAI's TTS models. ElevenLabs' non-v3 models
// support a small subset of SSML, and eleven_v3 understands its own
// "audio tags" syntax, which is more expressive than either — so the
// narrator-markup prompt is tailored to whichever the active TTS engine
// can actually interpret.
export type NarratorStyle = "plain" | "audio-tags" | "ssml-breaks";

export function narratorStyleFor(
	ttsProvider: TtsProvider,
	elevenLabsModel?: ElevenLabsModel,
): NarratorStyle {
	if (ttsProvider === "google") return "ssml-breaks";
	if (ttsProvider !== "elevenlabs") return "plain";
	return elevenLabsModel === "eleven_v3" ? "audio-tags" : "ssml-breaks";
}

const NARRATOR_SYSTEM_PLAIN = `You are a professional audiobook narrator assistant. Reformat the text below to read naturally aloud.
Rules:
- Do NOT change, add, or remove any words
- Add an em dash (—) where a narrator would pause briefly: after dialogue attributions, before scene shifts, at strong rhetorical breaks
- Add ellipsis (...) where a longer dramatic pause belongs: end of a tense sentence, after a revelation, trailing thoughts
- Preserve all paragraph breaks exactly
- Return ONLY the reformatted text with no preamble or explanation`;

const NARRATOR_SYSTEM_AUDIO_TAGS = `You are a professional audiobook narrator assistant, preparing text for ElevenLabs' eleven_v3 model. Reformat the text below to read naturally aloud.
Rules:
- Do NOT change, add, or remove any narrative words
- Insert [pause], [short pause], or [long pause] audio tags where a narrator would naturally pause: after dialogue attributions, before scene shifts, at strong rhetorical breaks, or for dramatic effect
- You may sparingly add emotional delivery tags (e.g. [whispers], [sighs], [laughs], [angry]) only where the text clearly implies that tone — do not invent actions the text doesn't support
- Preserve all paragraph breaks exactly
- Return ONLY the reformatted text with no preamble or explanation`;

const NARRATOR_SYSTEM_SSML_BREAKS = `You are a professional audiobook narrator assistant, preparing text for an ElevenLabs TTS model that supports a limited subset of SSML. Reformat the text below to read naturally aloud.
Rules:
- Do NOT change, add, or remove any words
- Insert <break time="0.4s" /> where a narrator would pause briefly: after dialogue attributions, before scene shifts, at strong rhetorical breaks
- Insert <break time="1.0s" /> where a longer dramatic pause belongs: end of a tense sentence, after a revelation, trailing thoughts
- Preserve all paragraph breaks exactly
- Return ONLY the reformatted text with no preamble or explanation`;

function systemPromptFor(style: NarratorStyle): string {
	if (style === "audio-tags") return NARRATOR_SYSTEM_AUDIO_TAGS;
	if (style === "ssml-breaks") return NARRATOR_SYSTEM_SSML_BREAKS;
	return NARRATOR_SYSTEM_PLAIN;
}

async function addNarratorMarkupClaude(
	anthropic: Anthropic,
	text: string,
	chunkSize: number,
	concurrency: number,
	systemPrompt: string,
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
						system: systemPrompt,
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
	systemPrompt: string,
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
							{ role: "system", content: systemPrompt },
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
	style: NarratorStyle = "plain",
): Promise<string> {
	const systemPrompt = systemPromptFor(style);
	if (provider === "claude-haiku") {
		if (!anthropic)
			throw new Error("Anthropic client required for claude-haiku provider");
		return addNarratorMarkupClaude(
			anthropic,
			text,
			chunkSize,
			concurrency,
			systemPrompt,
		);
	}
	return addNarratorMarkupGpt(
		openai,
		text,
		chunkSize,
		concurrency,
		systemPrompt,
	);
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

// ElevenLabs is used for TTS whenever a key is configured; OpenAI remains the
// default otherwise (and is always required for markup as a fallback).
export function detectTtsProvider(
	elevenLabsKey: string | undefined,
): TtsProvider {
	return elevenLabsKey ? "elevenlabs" : "openai";
}

// ── Narration-style suggestion ────────────────────────────────────────────────
// Only OpenAI's gpt-4o-mini-tts model accepts free-form narration "instructions" —
// ElevenLabs and OpenAI's tts-1/tts-1-hd have no equivalent, so callers should
// only invoke this when that model is active.

export interface NarrationStyleSuggestion {
	instructions: string;
	recognized: boolean;
}

const SUGGESTION_SYSTEM_PROMPT = `You are an expert audiobook director. You will be given a book's title, author, and a short excerpt from its text (which may be the opening pages, or a summary/synopsis chapter).

Decide whether you recognize this specific book from its title and author using your own knowledge. If you do, lean on what you know about its genre, tone, and register. If you do not confidently recognize it, base your judgement only on the excerpt provided.

Then write a single paragraph of narration-style instructions for a text-to-speech narrator voice, in the imperative, similar in spirit to: "You are a literary audiobook narrator. Speak with a mellow, warm baritone — measured and unhurried, never flat." Tailor the pacing, tone, and register to this specific book's genre and mood (for example: brisk and tense for a thriller, playful and light for comedic fiction, warm and simple for a children's book, measured and authoritative for nonfiction).

Respond in EXACTLY this format, with no other text before or after:
RECOGNIZED: yes|no
INSTRUCTIONS: <the single-paragraph narration style instructions>`;

function buildSuggestionUserMessage(
	metadata: BookMetadata,
	excerpt: string,
): string {
	return `Title: ${metadata.title}\nAuthor: ${metadata.author}\n\nExcerpt:\n${excerpt}`;
}

function parseSuggestionResponse(raw: string): NarrationStyleSuggestion {
	const recognizedMatch = raw.match(/RECOGNIZED:\s*(yes|no)/i);
	const instructionsMatch = raw.match(/INSTRUCTIONS:\s*([\s\S]*)/i);
	return {
		instructions: (instructionsMatch?.[1] ?? raw).trim(),
		recognized: (recognizedMatch?.[1] ?? "no").toLowerCase() === "yes",
	};
}

export async function suggestNarrationStyle(
	provider: MarkupProvider,
	anthropic: Anthropic | null,
	openai: OpenAI,
	metadata: BookMetadata,
	excerpt: string,
): Promise<NarrationStyleSuggestion> {
	if (provider === "claude-haiku" && !anthropic) {
		throw new Error("Anthropic client required for claude-haiku provider");
	}
	const userMessage = buildSuggestionUserMessage(metadata, excerpt);
	let lastError: unknown;
	for (let attempt = 1; attempt <= 3; attempt++) {
		try {
			if (provider === "claude-haiku" && anthropic) {
				const response = await anthropic.messages.create({
					model: "claude-haiku-4-5-20251001",
					max_tokens: 400,
					system: SUGGESTION_SYSTEM_PROMPT,
					messages: [{ role: "user", content: userMessage }],
				});
				const block = response.content[0];
				if (block?.type !== "text")
					throw new Error("Unexpected response type from Claude");
				return parseSuggestionResponse(block.text);
			}
			const response = await openai.chat.completions.create({
				model: "gpt-4o-mini",
				messages: [
					{ role: "system", content: SUGGESTION_SYSTEM_PROMPT },
					{ role: "user", content: userMessage },
				],
			});
			const content = response.choices[0]?.message?.content;
			if (!content) throw new Error("Empty response from GPT-4o mini");
			return parseSuggestionResponse(content);
		} catch (e) {
			lastError = e;
			if (attempt < 3) await sleep(1000 * attempt);
		}
	}
	throw lastError;
}

const PRICING = {
	claudeHaikuInputPerMTok: 0.8,
	claudeHaikuOutputPerMTok: 4.0,
	gpt4oMiniInputPerMTok: 0.15,
	gpt4oMiniOutputPerMTok: 0.6,
	tts1PerMChars: 15.0,
	tts1HdPerMChars: 30.0,
	// Approximate blended rate across ElevenLabs plans (~$0.15-0.22 / 1k chars).
	elevenLabsPerMChars: 180.0,
	// Google Neural2/Journey voices: $16 per 1M characters.
	googlePerMChars: 16.0,
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
	ttsProvider: TtsProvider = "openai",
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
		ttsProvider === "elevenlabs"
			? PRICING.elevenLabsPerMChars
			: ttsProvider === "google"
				? PRICING.googlePerMChars
				: ttsModel === "tts-1-hd"
					? PRICING.tts1HdPerMChars
					: PRICING.tts1PerMChars;
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
