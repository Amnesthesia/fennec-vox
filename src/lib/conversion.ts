import type Anthropic from "@anthropic-ai/sdk";
import { Buffer } from "buffer";
import type OpenAI from "openai";
import { synthesiseTextElevenLabs } from "./elevenlabs";
import { concatWavBuffers, synthesiseTextGemini } from "./gemini";
import { synthesiseTextGoogle } from "./google";
import { addNarratorMarkup, narratorStyleFor } from "./markup";
import { pLimit } from "./pLimit";
import { padded, splitIntoChunks } from "./text";
import type { ChunkCache } from "./tts";
import { synthesiseText } from "./tts";
import type {
	Chapter,
	ChapterRecord,
	ElevenLabsModel,
	GoogleTtsModel,
	MarkupProvider,
	ProgressEvent,
	TtsFormat,
	TtsModel,
	TtsProvider,
	TtsVoice,
} from "./types";
import {
	DEFAULT_ELEVENLABS_VOICE_ID,
	DEFAULT_GEMINI_VOICE_NAME,
	DEFAULT_GOOGLE_VOICE_NAME,
	innerTtsFormat,
} from "./types";

const TTS_MAX_CHARS = 4000;

// Platform-specific I/O injected into the conversion engine.
export interface ConversionIO {
	getMarkupCache(key: string): Promise<string | null>;
	setMarkupCache(key: string, value: string): Promise<void>;
	audioChunkCache: ChunkCache | null;
	chunkKey(chapterIndex: number, chunkIndex: number, format: string): string;
	saveChapterAudio(
		chapterIndex: number,
		data: Buffer,
		format: string,
	): Promise<string>;
	readChapterAudio(key: string): Promise<Buffer>;
	onProgress(event: ProgressEvent): void;
	onLog(message: string): void;
	isCancelled(): boolean;
	// Optional: called for m4b/m4a assembly; if absent, Buffer.concat is used
	onAssemble?: (
		chapterKeys: string[],
		chapterTitles: string[],
		bookTitle: string,
		bookAuthor: string,
	) => Promise<Buffer>;
}

interface ProcessorOpts {
	provider: MarkupProvider;
	anthropic: Anthropic | null;
	openai: OpenAI;
	// OpenAI TTS options (used when ttsProvider is "openai", the default).
	voice: TtsVoice;
	ttsModel: TtsModel;
	ttsInstructions?: string;
	// ElevenLabs TTS options (used when ttsProvider is "elevenlabs").
	ttsProvider?: TtsProvider;
	elevenLabsApiKey?: string;
	elevenLabsVoiceId?: string;
	elevenLabsModel?: ElevenLabsModel;
	// Google TTS options (used when ttsProvider is "google").
	googleApiKey?: string;
	googleVoiceName?: string;
	googleModel?: GoogleTtsModel;
	format: TtsFormat;
	chunkSize: number;
	concurrency: number;
	total: number;
	io: ConversionIO;
}

export async function processChapter(
	chapter: Chapter,
	opts: ProcessorOpts,
): Promise<{ file: string; audioBytes: number }> {
	const { index, title, text } = chapter;
	const {
		provider,
		anthropic,
		openai,
		voice,
		format,
		ttsModel,
		ttsProvider = "openai",
		elevenLabsApiKey,
		elevenLabsVoiceId,
		elevenLabsModel,
		googleApiKey,
		googleVoiceName,
		googleModel,
		chunkSize,
		concurrency,
		total,
		ttsInstructions,
		io,
	} = opts;

	io.onProgress({ type: "chapter_begin", index, title, total });
	io.onLog(
		`\n── Chapter ${index}/${total - 1}: "${title}" (${text.length.toLocaleString()} chars) ──`,
	);

	const narratorStyle = narratorStyleFor(
		ttsProvider,
		elevenLabsModel,
		googleModel,
	);
	const markupKey = `chapter-${padded(index)}.${narratorStyle}.txt`;
	let ttsText: string;

	const cached = await io.getMarkupCache(markupKey);
	if (cached !== null) {
		io.onLog(`  [${index}][1/2] Narrator markup loaded from cache`);
		ttsText = cached;
		io.onProgress({ type: "chapter_ssml", index });
	} else {
		io.onLog(`  [${index}][1/2] Narrator markup via ${provider}…`);
		io.onProgress({ type: "chapter_ssml", index });
		ttsText = await addNarratorMarkup(
			provider,
			anthropic,
			openai,
			text,
			chunkSize,
			concurrency,
			narratorStyle,
			googleApiKey,
		);
		await io.setMarkupCache(markupKey, ttsText);
	}

	const innerFmt = innerTtsFormat(format, ttsProvider, googleModel);
	const ttsChunks = splitIntoChunks(ttsText, TTS_MAX_CHARS).length;
	io.onProgress({ type: "chapter_tts", index, chunks: ttsChunks });
	io.onLog(
		`  [${index}][2/2] Synthesising audio via ${ttsProvider} (${ttsChunks} TTS chunk(s))…`,
	);

	const onTtsChunk = (i: number, tot: number, wasCached: boolean) =>
		io.onLog(
			`  [${index}]       TTS chunk ${i + 1}/${tot}${wasCached ? " (cached)" : ""}…`,
		);

	const audioBuffer =
		ttsProvider === "elevenlabs"
			? await synthesiseTextElevenLabs(
					elevenLabsApiKey ?? "",
					ttsText,
					elevenLabsVoiceId || DEFAULT_ELEVENLABS_VOICE_ID,
					format,
					elevenLabsModel ?? "eleven_multilingual_v2",
					concurrency,
					(i) => io.chunkKey(index, i, innerFmt),
					io.audioChunkCache,
					onTtsChunk,
				)
			: ttsProvider === "google" && googleModel === "gemini-2.5-flash"
				? await synthesiseTextGemini(
						googleApiKey ?? "",
						ttsText,
						googleVoiceName || DEFAULT_GEMINI_VOICE_NAME,
						concurrency,
						(i) => io.chunkKey(index, i, innerFmt),
						io.audioChunkCache,
						onTtsChunk,
					)
				: ttsProvider === "google"
					? await synthesiseTextGoogle(
							googleApiKey ?? "",
							ttsText,
							googleVoiceName || DEFAULT_GOOGLE_VOICE_NAME,
							format,
							concurrency,
							(i) => io.chunkKey(index, i, innerFmt),
							io.audioChunkCache,
							onTtsChunk,
						)
					: await synthesiseText(
							openai,
							ttsText,
							voice,
							innerFmt as "mp3" | "opus" | "aac" | "flac",
							ttsModel,
							concurrency,
							(i) => io.chunkKey(index, i, innerFmt),
							io.audioChunkCache,
							onTtsChunk,
							ttsInstructions,
						);

	const file = await io.saveChapterAudio(index, audioBuffer, innerFmt);
	io.onLog(
		`  [${index}] Chapter ${index} done ✓ (${(audioBuffer.length / 1024).toFixed(0)} KB)`,
	);
	io.onProgress({
		type: "chapter_done",
		index,
		title,
		file,
		audioBytes: audioBuffer.length,
	});

	return { file, audioBytes: audioBuffer.length };
}

export interface RunConversionOpts {
	chapters: Chapter[];
	completedChapters: Record<number, ChapterRecord>;
	provider: MarkupProvider;
	anthropic: Anthropic | null;
	openai: OpenAI;
	voice: TtsVoice;
	format: TtsFormat;
	ttsModel: TtsModel;
	ttsInstructions?: string;
	ttsProvider?: TtsProvider;
	elevenLabsApiKey?: string;
	elevenLabsVoiceId?: string;
	elevenLabsModel?: ElevenLabsModel;
	googleApiKey?: string;
	googleVoiceName?: string;
	googleModel?: GoogleTtsModel;
	chunkSize: number;
	concurrency: number;
	io: ConversionIO;
	bookTitle?: string;
	bookAuthor?: string;
	onChapterComplete?: (
		chapter: Chapter,
		record: ChapterRecord,
	) => Promise<void>;
}

export interface RunConversionResult {
	assembled: Buffer;
	chapterCount: number;
	total: number;
}

export async function runConversion(
	opts: RunConversionOpts,
): Promise<RunConversionResult> {
	const { chapters, completedChapters, io, concurrency, onChapterComplete } =
		opts;

	const processorOpts: ProcessorOpts = {
		provider: opts.provider,
		anthropic: opts.anthropic,
		openai: opts.openai,
		voice: opts.voice,
		format: opts.format,
		ttsModel: opts.ttsModel,
		ttsProvider: opts.ttsProvider,
		elevenLabsApiKey: opts.elevenLabsApiKey,
		elevenLabsVoiceId: opts.elevenLabsVoiceId,
		elevenLabsModel: opts.elevenLabsModel,
		googleApiKey: opts.googleApiKey,
		googleVoiceName: opts.googleVoiceName,
		googleModel: opts.googleModel,
		chunkSize: opts.chunkSize,
		concurrency: opts.concurrency,
		total: chapters.length,
		ttsInstructions: opts.ttsInstructions,
		io,
	};

	const pending = chapters.filter((ch) => !completedChapters[ch.index]);

	const tasks = pending.map((chapter) => async () => {
		if (io.isCancelled()) throw new Error("Conversion cancelled");
		const { file, audioBytes } = await processChapter(chapter, processorOpts);
		const record: ChapterRecord = {
			title: chapter.title,
			file,
			chars: chapter.text.length,
			audioBytes,
			completedAt: new Date().toISOString(),
		};
		completedChapters[chapter.index] = record;
		await onChapterComplete?.(chapter, record);
	});

	await pLimit(tasks, concurrency);

	io.onProgress({ type: "assembly" });
	io.onLog("\nAssembling final audiobook…");

	const sortedKeys = Object.keys(completedChapters)
		.map(Number)
		.sort((a, b) => a - b);

	const ttsProvider = opts.ttsProvider ?? "openai";
	const innerFmt = innerTtsFormat(opts.format, ttsProvider, opts.googleModel);

	let assembled: Buffer;
	if (io.onAssemble) {
		const chapterKeys = sortedKeys.map((k) => completedChapters[k]?.file);
		const chapterTitles = sortedKeys.map((k) => completedChapters[k]?.title);
		assembled = await io.onAssemble(
			chapterKeys,
			chapterTitles,
			opts.bookTitle ?? "",
			opts.bookAuthor ?? "",
		);
	} else if (innerFmt === "wav") {
		const parts = await Promise.all(
			sortedKeys.map((k) => io.readChapterAudio(completedChapters[k]?.file)),
		);
		assembled = concatWavBuffers(parts);
	} else {
		const parts = await Promise.all(
			sortedKeys.map((k) => io.readChapterAudio(completedChapters[k]?.file)),
		);
		assembled = Buffer.concat(parts);
	}

	return { assembled, chapterCount: sortedKeys.length, total: chapters.length };
}
