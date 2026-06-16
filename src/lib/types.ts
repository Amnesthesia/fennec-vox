export type MarkupProvider = "claude-haiku" | "gpt-4o-mini";
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
