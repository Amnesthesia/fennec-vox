export type MarkupProvider = "claude-haiku" | "gpt-4o-mini" | "gemini-flash";
export type TtsVoice =
	| "alloy"
	| "ash"
	| "ballad"
	| "coral"
	| "echo"
	| "fable"
	| "nova"
	| "onyx"
	| "sage"
	| "shimmer"
	| "verse";
export type TtsFormat = "mp3" | "opus" | "aac" | "flac" | "m4b" | "m4a";

export function ttsFormat(format: TtsFormat): "mp3" | "opus" | "aac" | "flac" {
	return format === "m4b" || format === "m4a" ? "aac" : format;
}
export type TtsModel = "tts-1" | "tts-1-hd" | "gpt-4o-mini-tts";

// ── TTS provider ──────────────────────────────────────────────────────────────

export type TtsProvider = "openai" | "elevenlabs" | "google";

// eleven_v3 is the only model that understands audio tags ([pause], [whispers], …);
// the others fall back to SSML <break> tags, which they support and v3 does not.
export type ElevenLabsModel =
	| "eleven_v3"
	| "eleven_multilingual_v2"
	| "eleven_flash_v2_5";

export const DEFAULT_ELEVENLABS_VOICE_ID = "21m00Tcm4TlvDq8ikWAM"; // "Rachel"

// Stable, publicly-available premade voices — shown as suggestions, but any
// voice ID (including cloned/custom voices) can be typed into the field.
export const ELEVENLABS_VOICES: { id: string; name: string }[] = [
	{ id: "21m00Tcm4TlvDq8ikWAM", name: "Rachel" },
	{ id: "pNInz6obpgDQGcFmaJgB", name: "Adam" },
	{ id: "ErXwobaYiN019PkySvjV", name: "Antoni" },
	{ id: "EXAVITQu4vr4xnSDxMaL", name: "Bella" },
	{ id: "AZnzlk1XvdvUeBnXmlld", name: "Domi" },
	{ id: "MF3mGyEYCl7XYWbV9V6O", name: "Elli" },
	{ id: "TxGEqnHWrfWFTfGW9XjX", name: "Josh" },
	{ id: "VR6AewLTigWG4xSOukaG", name: "Arnold" },
	{ id: "yoZ06aMxZJJ28mfd3POQ", name: "Sam" },
];

// ElevenLabs' TTS API only emits mp3/opus/pcm directly (no aac/flac); m4b/m4a
// chapters are synthesised as mp3 and transcoded to AAC when muxed (see audio.ts).
export function elevenLabsTtsFormat(format: TtsFormat): "mp3" | "opus" {
	return format === "opus" ? "opus" : "mp3";
}

// The format actually requested from the active TTS provider's API.
export function innerTtsFormat(
	format: TtsFormat,
	provider: TtsProvider,
): "mp3" | "opus" | "aac" | "flac" | "wav" {
	if (provider === "google") return "wav";
	if (provider === "elevenlabs") return format === "opus" ? "opus" : "mp3";
	return ttsFormat(format);
}

export const GEMINI_VOICES: { name: string; label: string }[] = [
	{ name: "Charon", label: "Charon (authoritative male)" },
	{ name: "Aoede", label: "Aoede (expressive female)" },
	{ name: "Fenrir", label: "Fenrir (deep male)" },
	{ name: "Kore", label: "Kore (warm female)" },
	{ name: "Puck", label: "Puck (youthful male)" },
	{ name: "Zephyr", label: "Zephyr (breathy female)" },
	{ name: "Leda", label: "Leda (soft female)" },
	{ name: "Orus", label: "Orus (strong male)" },
];
export const DEFAULT_GEMINI_VOICE_NAME = "Charon";

export interface Chapter {
	index: number;
	spineIndex: number;
	id: string;
	title: string;
	text: string;
}

export interface BookMetadata {
	title: string;
	author: string;
}

export interface ChapterRecord {
	title: string;
	file: string;
	chars: number;
	audioBytes: number;
	completedAt: string;
}

export interface CostEstimate {
	pendingChapters: number;
	skippedChapters: number;
	totalInputChars: number;
	inputTokens: number;
	outputTokens: number;
	totalTtsChars: number;
	claudeCost: number;
	ttsCost: number;
	totalCost: number;
	provider: MarkupProvider;
}

export interface Progress {
	completedChapters: Record<number, ChapterRecord>;
	epubFile?: string;
	bookTitle?: string;
	bookAuthor?: string;
	total?: number;
}

export type ProgressEvent =
	| {
			type: "start";
			provider: MarkupProvider;
			total: number;
			concurrency: number;
			completed: number[];
	  }
	| { type: "chapter_begin"; index: number; title: string; total: number }
	| { type: "chapter_ssml"; index: number }
	| { type: "chapter_tts"; index: number; chunks: number }
	| {
			type: "chapter_done";
			index: number;
			title: string;
			file: string;
			audioBytes: number;
	  }
	| { type: "chapter_skip"; index: number; title: string }
	| { type: "assembly" }
	| {
			type: "complete";
			outputFile: string;
			totalMB: number;
			chapters: number;
			total: number;
	  }
	| { type: "error"; message: string };
