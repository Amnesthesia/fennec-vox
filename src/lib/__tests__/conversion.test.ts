import type Anthropic from "@anthropic-ai/sdk";
import type OpenAI from "openai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversionIO, RunConversionOpts } from "../conversion";
import { processChapter, runConversion } from "../conversion";
import type { Chapter } from "../types";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeChapter(
	index: number,
	text = "Sample text for chapter.",
): Chapter {
	return {
		index,
		spineIndex: index,
		id: `ch-${index}`,
		title: `Chapter ${index}`,
		text,
	};
}

function makeIO(overrides: Partial<ConversionIO> = {}): ConversionIO {
	const audioStore = new Map<string, Buffer>();
	return {
		getMarkupCache: vi.fn().mockResolvedValue(null),
		setMarkupCache: vi.fn().mockResolvedValue(undefined),
		audioChunkCache: null,
		chunkKey: (ci, ki, fmt) => `ch-${ci}-chunk-${ki}.${fmt}`,
		saveChapterAudio: vi
			.fn()
			.mockImplementation(async (idx: number, data: Buffer, fmt: string) => {
				const key = `ch-${idx}.${fmt}`;
				audioStore.set(key, data);
				return key;
			}),
		readChapterAudio: vi.fn().mockImplementation(async (key: string) => {
			return audioStore.get(key) ?? Buffer.alloc(0);
		}),
		onProgress: vi.fn(),
		onLog: vi.fn(),
		isCancelled: vi.fn().mockReturnValue(false),
		...overrides,
	};
}

// Provides both markup (chat.completions) and TTS (audio.speech) mocks
function makeFullOpenai(audioBuf = Buffer.from("audio")) {
	return {
		chat: {
			completions: {
				create: vi.fn().mockResolvedValue({
					choices: [{ message: { content: "marked text" } }],
				}),
			},
		},
		audio: {
			speech: {
				create: vi.fn().mockResolvedValue({
					arrayBuffer: () => {
						const ab = audioBuf.buffer.slice(
							audioBuf.byteOffset,
							audioBuf.byteOffset + audioBuf.byteLength,
						);
						return Promise.resolve(ab);
					},
				}),
			},
		},
	} as unknown as OpenAI;
}

function makeMarkupMock(text = "marked") {
	return {
		messages: {
			create: vi.fn().mockResolvedValue({ content: [{ type: "text", text }] }),
		},
	} as unknown as Anthropic;
}

// ── processChapter ────────────────────────────────────────────────────────────

describe("processChapter", () => {
	beforeEach(() => vi.clearAllMocks());

	it("runs markup → TTS → saves audio, emits progress events", async () => {
		const chapter = makeChapter(0);
		const io = makeIO();
		const anthropic = makeMarkupMock("narrated text");
		const openai = makeFullOpenai(Buffer.from("tts-audio"));

		const result = await processChapter(chapter, {
			provider: "claude-haiku",
			anthropic,
			openai,
			voice: "alloy",
			format: "mp3",
			ttsModel: "tts-1",
			chunkSize: 2000,
			concurrency: 1,
			total: 1,
			io,
		});

		expect(result.file).toBe("ch-0.mp3");
		expect(result.audioBytes).toBeGreaterThan(0);
		expect(io.setMarkupCache).toHaveBeenCalledOnce();
		expect(io.saveChapterAudio).toHaveBeenCalledOnce();

		const progressTypes = (
			io.onProgress as ReturnType<typeof vi.fn>
		).mock.calls.map((c) => c[0].type);
		expect(progressTypes).toContain("chapter_begin");
		expect(progressTypes).toContain("chapter_ssml");
		expect(progressTypes).toContain("chapter_tts");
		expect(progressTypes).toContain("chapter_done");
	});

	it("uses markup cache when available, skips API call", async () => {
		const chapter = makeChapter(0);
		const io = makeIO({
			getMarkupCache: vi.fn().mockResolvedValue("cached markup"),
		});
		const anthropic = makeMarkupMock();
		const openai = makeFullOpenai();

		await processChapter(chapter, {
			provider: "claude-haiku",
			anthropic,
			openai,
			voice: "alloy",
			format: "mp3",
			ttsModel: "tts-1",
			chunkSize: 2000,
			concurrency: 1,
			total: 1,
			io,
		});

		expect(anthropic.messages.create).not.toHaveBeenCalled();
		expect(io.setMarkupCache).not.toHaveBeenCalled();
	});
});

// ── runConversion ─────────────────────────────────────────────────────────────

describe("runConversion", () => {
	beforeEach(() => vi.clearAllMocks());

	function makeOpts(
		chapters: Chapter[],
		overrides: Partial<RunConversionOpts> = {},
	): RunConversionOpts {
		return {
			chapters,
			completedChapters: {},
			provider: "gpt-4o-mini",
			anthropic: null,
			openai: makeFullOpenai() as never,
			voice: "alloy",
			format: "mp3",
			ttsModel: "tts-1",
			chunkSize: 2000,
			concurrency: 1,
			io: makeIO(),
			...overrides,
		};
	}

	it("processes all pending chapters and assembles audio", async () => {
		const chapters = [
			makeChapter(0, "Chapter zero text."),
			makeChapter(1, "Chapter one text."),
		];
		const result = await runConversion(makeOpts(chapters));
		expect(result.chapterCount).toBe(2);
		expect(result.total).toBe(2);
		expect(result.assembled.length).toBeGreaterThan(0);
	});

	it("skips already-completed chapters", async () => {
		const chapters = [makeChapter(0), makeChapter(1), makeChapter(2)];
		const audioStore = new Map<string, Buffer>([
			["ch-0.mp3", Buffer.from("pre")],
		]);
		const io = makeIO({
			saveChapterAudio: vi
				.fn()
				.mockImplementation(async (idx: number, data: Buffer, fmt: string) => {
					const key = `ch-${idx}.${fmt}`;
					audioStore.set(key, data);
					return key;
				}),
			readChapterAudio: vi
				.fn()
				.mockImplementation(
					async (key: string) => audioStore.get(key) ?? Buffer.from("pre"),
				),
		});

		const completedChapters = {
			0: {
				title: "Ch 0",
				file: "ch-0.mp3",
				chars: 5,
				audioBytes: 3,
				completedAt: "",
			},
		};

		const result = await runConversion(
			makeOpts(chapters, { completedChapters, io }),
		);
		expect(io.saveChapterAudio).toHaveBeenCalledTimes(2);
		expect(result.chapterCount).toBe(3);
	});

	it("calls onChapterComplete for each chapter processed", async () => {
		const chapters = [makeChapter(0), makeChapter(1)];
		const onChapterComplete = vi.fn().mockResolvedValue(undefined);
		await runConversion(makeOpts(chapters, { onChapterComplete }));
		expect(onChapterComplete).toHaveBeenCalledTimes(2);
	});

	it("respects cancellation between chapters", async () => {
		const cancelled = { value: false };
		const io = makeIO({
			isCancelled: vi.fn().mockImplementation(() => cancelled.value),
			saveChapterAudio: vi
				.fn()
				.mockImplementation(async (idx: number, _data: Buffer, fmt: string) => {
					if (idx === 0) cancelled.value = true;
					const key = `ch-${idx}.${fmt}`;
					return key;
				}),
			readChapterAudio: vi.fn().mockResolvedValue(Buffer.from("x")),
		});

		const chapters = [makeChapter(0), makeChapter(1)];
		await expect(runConversion(makeOpts(chapters, { io }))).rejects.toThrow(
			"Conversion cancelled",
		);
	});

	it("emits assembly progress event", async () => {
		const chapters = [makeChapter(0)];
		const io = makeIO();
		await runConversion(makeOpts(chapters, { io }));

		const types = (io.onProgress as ReturnType<typeof vi.fn>).mock.calls.map(
			(c) => c[0].type,
		);
		expect(types).toContain("assembly");
	});
});
