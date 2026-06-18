// Shared IPC channel names and payload types used by main, preload, and renderer.

export const IPC = {
	// renderer → main (invoke)
	SELECT_EPUB: "select-epub",
	SELECT_OUTPUT_DIR: "select-output-dir",
	GET_CREDENTIALS: "get-credentials",
	SAVE_CREDENTIALS: "save-credentials",
	START_CONVERSION: "start-conversion",
	STOP_CONVERSION: "stop-conversion",
	PREVIEW_VOICE: "preview-voice",
	SUGGEST_NARRATION_STYLE: "suggest-narration-style",
	OPEN_EXTERNAL: "open-external",

	// main → renderer (send)
	CONVERSION_PROGRESS: "conversion-progress",
	CONVERSION_LOG: "conversion-log",
	CONVERSION_COMPLETE: "conversion-complete",
	CONVERSION_ERROR: "conversion-error",
} as const;

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
export type TtsModel = "tts-1" | "tts-1-hd" | "gpt-4o-mini-tts";

export type TtsProvider = "openai" | "elevenlabs" | "google";
export type ElevenLabsModel =
	| "eleven_v3"
	| "eleven_multilingual_v2"
	| "eleven_flash_v2_5";
export type MarkupProvider = "claude-haiku" | "gpt-4o-mini" | "gemini-flash";

export interface ConversionOptions {
	epubPath: string;
	outputDir: string;
	voice: TtsVoice;
	format: TtsFormat;
	ttsModel: TtsModel;
	ttsProvider: TtsProvider;
	chunkSize: number;
	concurrency: number;
	resumeFrom?: number;
	ttsInstructions?: string;
	redoTts?: boolean;
	// Used instead of `voice`/`ttsModel` when ttsProvider is "elevenlabs".
	elevenLabsVoiceId?: string;
	elevenLabsModel?: ElevenLabsModel;
	// Used when ttsProvider is "google" (Gemini).
	googleVoiceName?: string;
}

export interface Credentials {
	anthropicKey: string;
	openaiKey: string;
	elevenLabsKey: string;
	googleKey: string;
}

export interface PreviewVoiceOpts {
	text: string;
	ttsProvider: TtsProvider;
	// OpenAI
	voice?: TtsVoice;
	model?: TtsModel;
	instructions?: string;
	// ElevenLabs
	elevenLabsVoiceId?: string;
	elevenLabsModel?: ElevenLabsModel;
	// Google (Gemini)
	googleVoiceName?: string;
}

// Only meaningful for OpenAI's gpt-4o-mini-tts model, which is the only TTS
// model/provider combination that accepts free-form narration instructions.
export interface SuggestNarrationStyleOpts {
	epubPath: string;
}

export interface SuggestNarrationStyleResult {
	instructions?: string;
	recognized?: boolean;
	bookTitle?: string;
	bookAuthor?: string;
	error?: string;
}

// Mirrors ProgressEvent in convert.ts (re-declared to avoid cross-package import)
export type ProgressEvent =
	| {
			type: "start";
			provider: string;
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

// What the renderer knows about the active conversion state
export interface ConversionState {
	running: boolean;
	currentChapter: number;
	totalChapters: number;
	chapterTitle: string;
	step: "idle" | "ssml" | "tts" | "assembly" | "done" | "error";
	provider: string;
	outputFile?: string;
	errorMessage?: string;
}
