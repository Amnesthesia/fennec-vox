import type Anthropic from "@anthropic-ai/sdk";
import { Buffer } from "buffer";
import type OpenAI from "openai";
import { addNarratorMarkup } from "./markup";
import { pLimit } from "./pLimit";
import { padded, splitIntoChunks } from "./text";
import type { ChunkCache } from "./tts";
import { synthesiseText } from "./tts";
import type {
	Chapter,
	ChapterRecord,
	MarkupProvider,
	ProgressEvent,
	TtsFormat,
	TtsModel,
	TtsVoice,
} from "./types";
import { ttsFormat } from "./types";

const TTS_MAX_CHARS = 4000;

// Platform-specific I/O injected into the conversion engine.
export interface ConversionIO {
	getMarkupCache(key: string): Promise<string | null>;
	setMarkupCache(key: string, value: string): Promise<void>;
	audioChunkCache: ChunkCache | null;
	chunkKey(chapterIndex: number, chunkIndex: number, format: TtsFormat): string;
	saveChapterAudio(
		chapterIndex: number,
		data: Buffer,
		format: TtsFormat,
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
	voice: TtsVoice;
	format: TtsFormat;
	ttsModel: TtsModel;
	chunkSize: number;
	concurrency: number;
	total: number;
	ttsInstructions?: string;
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

	const markupKey = `chapter-${padded(index)}.txt`;
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
		);
		await io.setMarkupCache(markupKey, ttsText);
	}

	const innerFmt = ttsFormat(format);
	const ttsChunks = splitIntoChunks(ttsText, TTS_MAX_CHARS).length;
	io.onProgress({ type: "chapter_tts", index, chunks: ttsChunks });
	io.onLog(`  [${index}][2/2] Synthesising audio (${ttsChunks} TTS chunk(s))…`);

	const audioBuffer = await synthesiseText(
		openai,
		ttsText,
		voice,
		innerFmt,
		ttsModel,
		concurrency,
		(i) => io.chunkKey(index, i, innerFmt),
		io.audioChunkCache,
		(i, tot, wasCached) =>
			io.onLog(
				`  [${index}]       TTS chunk ${i + 1}/${tot}${wasCached ? " (cached)" : ""}…`,
			),
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
	chunkSize: number;
	concurrency: number;
	ttsInstructions?: string;
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
	const {
		chapters,
		completedChapters,
		io,
		concurrency,
		onChapterComplete,
		format,
	} = opts;

	const processorOpts: ProcessorOpts = {
		provider: opts.provider,
		anthropic: opts.anthropic,
		openai: opts.openai,
		voice: opts.voice,
		format: opts.format,
		ttsModel: opts.ttsModel,
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

	let assembled: Buffer;
	if ((format === "m4b" || format === "m4a") && io.onAssemble) {
		const chapterKeys = sortedKeys.map((k) => completedChapters[k]?.file);
		const chapterTitles = sortedKeys.map((k) => completedChapters[k]?.title);
		assembled = await io.onAssemble(
			chapterKeys,
			chapterTitles,
			opts.bookTitle ?? "",
			opts.bookAuthor ?? "",
		);
	} else {
		const parts = await Promise.all(
			sortedKeys.map((k) => io.readChapterAudio(completedChapters[k]?.file)),
		);
		assembled = Buffer.concat(parts);
	}

	return { assembled, chapterCount: sortedKeys.length, total: chapters.length };
}
