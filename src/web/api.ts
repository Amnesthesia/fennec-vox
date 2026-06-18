import Anthropic from "@anthropic-ai/sdk";
import type {
	ConversionOptions,
	PreviewVoiceOpts,
	SuggestNarrationStyleOpts,
	SuggestNarrationStyleResult,
} from "@shared/ipc";
import OpenAI from "openai";
import type { ConversionIO } from "../lib/conversion";
import { runConversion } from "../lib/conversion";
import { getCredentials, saveCredentials } from "../lib/credentials/browser";
import { elevenLabsOutputFormat } from "../lib/elevenlabs";
import { extractChapters as extractEpubBrowser } from "../lib/epub/browser";
import {
	detectMarkupProvider,
	estimateCosts,
	suggestNarrationStyle,
} from "../lib/markup";
import { extractChaptersPdf as extractPdfBrowser } from "../lib/pdf/browser";
import { findExcerpt } from "../lib/text";
import type {
	Chapter,
	ChapterRecord,
	ProgressEvent,
	TtsFormat,
} from "../lib/types";
import { innerTtsFormat } from "../lib/types";

// ── Internal state ────────────────────────────────────────────────────────────

let pendingFile: File | null = null;
let stopRequested = false;

type ProgressCb = (e: ProgressEvent) => void;
type LogCb = (line: string) => void;
type CompleteCb = (e: ProgressEvent & { type: "complete" }) => void;
type ErrorCb = (msg: string) => void;

const progressListeners: Set<ProgressCb> = new Set();
const logListeners: Set<LogCb> = new Set();
const completeListeners: Set<CompleteCb> = new Set();
const errorListeners: Set<ErrorCb> = new Set();

function emitProgress(e: ProgressEvent) {
	progressListeners.forEach((cb) => {
		cb(e);
	});
}
function emitLog(msg: string) {
	logListeners.forEach((cb) => {
		cb(msg);
	});
}
function emitComplete(e: ProgressEvent & { type: "complete" }) {
	completeListeners.forEach((cb) => {
		cb(e);
	});
}
function emitError(msg: string) {
	errorListeners.forEach((cb) => {
		cb(msg);
	});
}

// ── Browser ConversionIO (in-memory, no caching) ──────────────────────────────

function createBrowserIO(): ConversionIO {
	const audioStore = new Map<string, Buffer>();

	return {
		async getMarkupCache(_key) {
			return null;
		},
		async setMarkupCache(_key, _value) {},
		audioChunkCache: null,
		chunkKey(chapterIdx, chunkIdx, fmt) {
			return `chapter-${chapterIdx}-chunk-${chunkIdx}.${fmt}`;
		},
		async saveChapterAudio(chapterIdx, data, fmt) {
			const key = `chapter-${chapterIdx}.${fmt}`;
			audioStore.set(key, data);
			return key;
		},
		async readChapterAudio(key) {
			const buf = audioStore.get(key);
			if (!buf) throw new Error(`Audio chunk not found in memory: ${key}`);
			return buf;
		},
		onProgress(event) {
			emitProgress(event);
			if (event.type === "complete") emitComplete(event);
		},
		onLog(msg) {
			emitLog(msg);
		},
		isCancelled() {
			return stopRequested;
		},
	};
}

// ── Public API (mirrors ElectronAPI shape) ────────────────────────────────────

export const browserApi = {
	selectEpub(): Promise<string | null> {
		return new Promise((resolve) => {
			const input = document.createElement("input");
			input.type = "file";
			input.accept = ".epub,.pdf";
			input.onchange = () => {
				const file = input.files?.[0];
				if (file) {
					pendingFile = file;
					resolve(file.name);
				} else resolve(null);
			};
			input.click();
		});
	},

	selectOutputDir(): Promise<string | null> {
		return Promise.resolve("browser-download");
	},

	getCredentials,

	saveCredentials(c: {
		anthropicKey: string;
		openaiKey: string;
		elevenLabsKey: string;
		googleKey: string;
	}): Promise<void> {
		return saveCredentials(c);
	},

	openExternal(url: string): Promise<void> {
		window.open(url, "_blank", "noopener,noreferrer");
		return Promise.resolve();
	},

	async previewVoice(
		opts: PreviewVoiceOpts,
	): Promise<{ audio?: string; error?: string }> {
		if (opts.ttsProvider === "elevenlabs") {
			const { elevenLabsKey } = await getCredentials();
			if (!elevenLabsKey) return { error: "No ElevenLabs key configured." };
			if (!opts.elevenLabsVoiceId)
				return { error: "No ElevenLabs voice selected." };
			try {
				const outputFormat = elevenLabsOutputFormat("mp3");
				const res = await fetch(
					`https://api.elevenlabs.io/v1/text-to-speech/${opts.elevenLabsVoiceId}?output_format=${outputFormat}`,
					{
						method: "POST",
						headers: {
							"xi-api-key": elevenLabsKey,
							"Content-Type": "application/json",
						},
						body: JSON.stringify({
							text: opts.text,
							model_id: opts.elevenLabsModel ?? "eleven_v3",
						}),
					},
				);
				if (!res.ok) {
					const errBody = await res.text().catch(() => "");
					return {
						error: `ElevenLabs preview failed (${res.status}): ${errBody || res.statusText}`,
					};
				}
				const arrayBuffer = await res.arrayBuffer();
				const base64 = btoa(
					String.fromCharCode(...new Uint8Array(arrayBuffer)),
				);
				return { audio: base64 };
			} catch (e: unknown) {
				return { error: String(e) };
			}
		}

		if (opts.ttsProvider === "google") {
			const { googleKey } = await getCredentials();
			if (!googleKey) return { error: "No Google API key configured." };
			if (!opts.googleVoiceName) return { error: "No Gemini voice selected." };
			try {
				const res = await fetch(
					`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro-preview-tts:generateContent?key=${googleKey}`,
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							contents: [{ parts: [{ text: opts.text }], role: "user" }],
							generationConfig: {
								responseModalities: ["AUDIO"],
								speechConfig: {
									voiceConfig: {
										prebuiltVoiceConfig: {
											voiceName: opts.googleVoiceName,
										},
									},
								},
							},
						}),
					},
				);
				if (!res.ok) {
					const errBody = await res.text().catch(() => "");
					return {
						error: `Gemini TTS preview failed (${res.status}): ${errBody || res.statusText}`,
					};
				}
				const json = (await res.json()) as {
					candidates: Array<{
						content: {
							parts: Array<{ inlineData: { data: string } }>;
						};
					}>;
				};
				const data = json.candidates[0]?.content?.parts[0]?.inlineData?.data;
				if (!data) return { error: "No audio in Gemini TTS response" };
				return { audio: data };
			} catch (e: unknown) {
				return { error: String(e) };
			}
		}

		const { openaiKey } = await getCredentials();
		if (!openaiKey) return { error: "No OpenAI key configured." };
		try {
			const body: Record<string, unknown> = {
				model: opts.model,
				input: opts.text,
				voice: opts.voice,
			};
			if (opts.instructions) body.instructions = opts.instructions;
			const res = await fetch("https://api.openai.com/v1/audio/speech", {
				method: "POST",
				headers: {
					Authorization: `Bearer ${openaiKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(body),
			});
			if (!res.ok) return { error: `TTS preview failed: ${res.statusText}` };
			const arrayBuffer = await res.arrayBuffer();
			const base64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)));
			return { audio: base64 };
		} catch (e: unknown) {
			return { error: String(e) };
		}
	},

	async suggestNarrationStyle(
		_opts: SuggestNarrationStyleOpts,
	): Promise<SuggestNarrationStyleResult> {
		if (!pendingFile) return { error: "No file available." };

		const { anthropicKey, openaiKey } = await getCredentials();
		if (!openaiKey) return { error: "OpenAI API key is required." };

		let provider: ReturnType<typeof detectMarkupProvider>;
		try {
			provider = detectMarkupProvider(anthropicKey || undefined, openaiKey);
		} catch (e) {
			return { error: (e as Error).message };
		}

		try {
			const lower = pendingFile.name.toLowerCase();
			let chapters: Chapter[];
			let metadata: { title: string; author: string };
			if (lower.endsWith(".epub")) {
				({ chapters, metadata } = await extractEpubBrowser(pendingFile));
			} else if (lower.endsWith(".pdf")) {
				({ chapters, metadata } = await extractPdfBrowser(pendingFile));
			} else {
				return { error: "Unsupported file type. Use EPUB or PDF." };
			}
			const { excerpt } = findExcerpt(chapters);
			const anthropic = anthropicKey
				? new Anthropic({
						apiKey: anthropicKey,
						dangerouslyAllowBrowser: true,
					})
				: null;
			const openai = new OpenAI({
				apiKey: openaiKey,
				dangerouslyAllowBrowser: true,
			});
			const { instructions, recognized } = await suggestNarrationStyle(
				provider,
				anthropic,
				openai,
				metadata,
				excerpt,
			);
			return {
				instructions,
				recognized,
				bookTitle: metadata.title,
				bookAuthor: metadata.author,
			};
		} catch (e: unknown) {
			return { error: (e as Error).message ?? String(e) };
		}
	},

	async startConversion(
		opts: ConversionOptions,
	): Promise<{ ok?: boolean; error?: string }> {
		if (!pendingFile && !opts.epubPath) return { error: "No file selected." };

		stopRequested = false;

		const { anthropicKey, openaiKey, elevenLabsKey, googleKey } =
			await getCredentials();
		const ttsProvider = opts.ttsProvider;
		const isGeminiMode = ttsProvider === "google";

		if (!openaiKey && !isGeminiMode)
			return {
				error:
					"OpenAI or Google API key is required. Configure it in Settings.",
			};

		let provider: import("../lib/types").MarkupProvider;
		if (isGeminiMode) {
			provider = "gemini-flash";
		} else {
			try {
				provider = detectMarkupProvider(anthropicKey || undefined, openaiKey);
			} catch (e) {
				return { error: (e as Error).message };
			}
		}

		// Run async — return immediately so the UI can subscribe to events first
		void (async () => {
			try {
				const file = pendingFile;

				let chapters: Awaited<
					ReturnType<typeof extractEpubBrowser>
				>["chapters"];
				let metadata: Awaited<
					ReturnType<typeof extractEpubBrowser>
				>["metadata"];

				if (file) {
					const lower = file.name.toLowerCase();
					if (lower.endsWith(".epub")) {
						({ chapters, metadata } = await extractEpubBrowser(file));
					} else if (lower.endsWith(".pdf")) {
						({ chapters, metadata } = await extractPdfBrowser(file));
					} else {
						emitError("Unsupported file type. Use EPUB or PDF.");
						return;
					}
				} else {
					emitError("No file available. Please select a file first.");
					return;
				}

				const completedChapters: Record<number, ChapterRecord> = {};
				const estimate = estimateCosts(
					Object.values(completedChapters) as never,
					{},
					opts.chunkSize,
					opts.ttsModel,
					provider,
					ttsProvider,
				);
				void estimate;

				emitProgress({
					type: "start",
					provider,
					total: chapters.length,
					concurrency: opts.concurrency,
					completed: [],
				});
				emitLog(`Book: "${metadata.title}" by ${metadata.author}`);
				emitLog(
					`Chapters: ${chapters.length}  |  Markup: ${provider}  |  TTS: ${ttsProvider}`,
				);

				const anthropic = anthropicKey
					? new Anthropic({
							apiKey: anthropicKey,
							dangerouslyAllowBrowser: true,
						})
					: null;
				const openai = new OpenAI({
					apiKey: openaiKey || "unused",
					dangerouslyAllowBrowser: true,
				});
				const io: ConversionIO = createBrowserIO();

				const { assembled, chapterCount, total } = await runConversion({
					chapters,
					completedChapters,
					provider,
					anthropic,
					openai,
					voice: opts.voice,
					format: opts.format as TtsFormat,
					ttsModel: opts.ttsModel,
					ttsProvider,
					elevenLabsApiKey: elevenLabsKey || undefined,
					elevenLabsVoiceId: opts.elevenLabsVoiceId,
					elevenLabsModel: opts.elevenLabsModel,
					googleApiKey: googleKey || undefined,
					googleVoiceName: opts.googleVoiceName,
					chunkSize: opts.chunkSize,
					concurrency: opts.concurrency,
					ttsInstructions: opts.ttsInstructions,
					io,
					onChapterComplete: async (_ch: Chapter, _rec: ChapterRecord) => {},
				});

				if (stopRequested) {
					emitLog("Conversion stopped.");
					return;
				}

				// Download the result (named after the format actually synthesised,
				// since ElevenLabs returns mp3/opus regardless of the requested format)
				const ext = innerTtsFormat(opts.format as TtsFormat, ttsProvider);
				const mimeTypes: Record<string, string> = {
					mp3: "audio/mpeg",
					opus: "audio/ogg",
					aac: "audio/aac",
					flac: "audio/flac",
					wav: "audio/wav",
				};
				const mime = mimeTypes[ext] ?? "audio/mpeg";
				const blob = new Blob([new Uint8Array(assembled)], { type: mime });
				const url = URL.createObjectURL(blob);
				const a = document.createElement("a");
				const baseName = (pendingFile?.name ?? "audiobook").replace(
					/\.[^.]+$/,
					"",
				);
				a.href = url;
				a.download = `${baseName}.${ext}`;
				a.click();
				setTimeout(() => URL.revokeObjectURL(url), 60_000);

				const totalMB = assembled.length / 1024 / 1024;
				emitLog(
					`\nDone! ${chapterCount}/${total} chapters — ${totalMB.toFixed(2)} MB`,
				);
				emitProgress({
					type: "complete",
					outputFile: a.download,
					totalMB,
					chapters: chapterCount,
					total,
				});
			} catch (e: unknown) {
				if (!stopRequested) {
					const msg = (e as Error).message ?? String(e);
					emitLog(`[ERROR] ${msg}`);
					console.error(e);
					emitError(msg);
					emitProgress({ type: "error", message: msg });
				}
			}
		})();

		return { ok: true };
	},

	stopConversion(): Promise<{ ok?: boolean; error?: string }> {
		stopRequested = true;
		return Promise.resolve({ ok: true });
	},

	onProgress(cb: ProgressCb): () => void {
		progressListeners.add(cb);
		return () => progressListeners.delete(cb);
	},
	onLog(cb: LogCb): () => void {
		logListeners.add(cb);
		return () => logListeners.delete(cb);
	},
	onComplete(cb: CompleteCb): () => void {
		completeListeners.add(cb);
		return () => completeListeners.delete(cb);
	},
	onError(cb: ErrorCb): () => void {
		errorListeners.add(cb);
		return () => errorListeners.delete(cb);
	},

	// Browser-only: register a dropped File so startConversion can use it
	registerDroppedFile(file: File): string {
		pendingFile = file;
		return file.name;
	},
};

export type BrowserAPI = typeof browserApi;
