import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import type {
	ConversionOptions,
	Credentials,
	PreviewVoiceOpts,
	SuggestNarrationStyleOpts,
} from "@shared/ipc";
import { IPC } from "@shared/ipc";
import { Buffer } from "buffer";
import { type BrowserWindow, dialog, ipcMain, shell } from "electron";
import fs from "fs-extra";
import OpenAI from "openai";
import {
	buildAudioFromChapters,
	buildM4b,
	resolveFfmpegBin,
} from "../lib/audio";
import type { ConversionIO } from "../lib/conversion";
import { runConversion } from "../lib/conversion";
import { elevenLabsOutputFormat } from "../lib/elevenlabs";
import {
	detectMarkupProvider,
	estimateCosts,
	suggestNarrationStyle,
} from "../lib/markup";
import { extractContent } from "../lib/pdf/node";
import { findExcerpt, padded, safeFilename } from "../lib/text";
import type {
	Chapter,
	ChapterRecord,
	Progress,
	TtsFormat,
	TtsProvider,
} from "../lib/types";
import { innerTtsFormat } from "../lib/types";
import { getCredentials, saveCredentials } from "./keychain";

interface CancellationToken {
	cancelled: boolean;
}
let activeToken: CancellationToken | null = null;

function getProgressPath(dir: string): string {
	return path.join(dir, "progress.json");
}

async function loadProgress(dir: string): Promise<Progress> {
	try {
		return (await fs.readJson(getProgressPath(dir))) as Progress;
	} catch {
		return { completedChapters: {} };
	}
}

async function saveProgress(dir: string, data: Progress): Promise<void> {
	await fs.writeJson(getProgressPath(dir), data, { spaces: 2 });
}

function createNodeIO(
	chaptersDir: string,
	narratorDir: string,
	token: CancellationToken,
	format: TtsFormat,
	bookTitle: string,
	bookAuthor: string,
	outputFile: string,
	send: (channel: string, payload?: unknown) => void,
	ttsProvider: TtsProvider,
): ConversionIO {
	const innerFmt = innerTtsFormat(format, ttsProvider);
	const needsFfmpegAssembly =
		format === "m4b" || format === "m4a" || innerFmt === "wav";

	return {
		async getMarkupCache(key) {
			try {
				return await fs.readFile(path.join(narratorDir, key), "utf8");
			} catch {
				return null;
			}
		},
		async setMarkupCache(key, value) {
			await fs.writeFile(path.join(narratorDir, key), value, "utf8");
		},
		audioChunkCache: {
			async get(key) {
				try {
					return await fs.readFile(key);
				} catch {
					return null;
				}
			},
			async set(key, data) {
				await fs.writeFile(key, data);
			},
		},
		chunkKey(chapterIdx, chunkIdx, fmt) {
			return path.join(
				chaptersDir,
				`chapter-${padded(chapterIdx)}-chunk-${padded(chunkIdx)}.${fmt}`,
			);
		},
		async saveChapterAudio(chapterIdx, data, fmt) {
			const file = path.join(
				chaptersDir,
				`chapter-${padded(chapterIdx)}.${fmt}`,
			);
			await fs.writeFile(file, data);
			return file;
		},
		async readChapterAudio(key) {
			return fs.readFile(key);
		},
		onProgress(event) {
			send(IPC.CONVERSION_PROGRESS, event);
			if (event.type === "complete") send(IPC.CONVERSION_COMPLETE, event);
		},
		onLog(msg) {
			send(IPC.CONVERSION_LOG, msg);
		},
		isCancelled() {
			return token.cancelled;
		},
		...(needsFfmpegAssembly
			? {
					async onAssemble(chapterKeys: string[], chapterTitles: string[]) {
						const ffmpegBin = resolveFfmpegBin();
						send(IPC.CONVERSION_LOG, `Using ffmpeg: ${ffmpegBin}`);
						if (format === "m4b" || format === "m4a") {
							const chaps = chapterKeys.map((file, i) => ({
								file,
								title: chapterTitles[i] ?? "",
							}));
							return buildM4b(
								chaps,
								outputFile,
								bookTitle,
								bookAuthor,
								ffmpegBin,
							);
						}
						// Non-m4b with WAV chapters (Gemini): use ffmpeg concat+convert
						return buildAudioFromChapters(chapterKeys, outputFile, ffmpegBin);
					},
				}
			: {}),
	};
}

export function registerIpcHandlers(win: BrowserWindow): void {
	// ── File / folder pickers ─────────────────────────────────────────────────

	ipcMain.handle(IPC.SELECT_EPUB, async () => {
		const result = await dialog.showOpenDialog(win, {
			title: "Select EPUB or PDF file",
			filters: [
				{ name: "Books", extensions: ["epub", "pdf"] },
				{ name: "EPUB", extensions: ["epub"] },
				{ name: "PDF", extensions: ["pdf"] },
			],
			properties: ["openFile"],
		});
		return result.canceled ? null : (result.filePaths[0] ?? null);
	});

	ipcMain.handle(IPC.SELECT_OUTPUT_DIR, async () => {
		const result = await dialog.showOpenDialog(win, {
			title: "Select output directory",
			properties: ["openDirectory", "createDirectory"],
		});
		return result.canceled ? null : (result.filePaths[0] ?? null);
	});

	// ── Credentials ───────────────────────────────────────────────────────────

	ipcMain.handle(IPC.GET_CREDENTIALS, () => getCredentials());

	ipcMain.handle(IPC.SAVE_CREDENTIALS, (_event, creds: Credentials) => {
		return saveCredentials(creds);
	});

	// ── Open external URL ─────────────────────────────────────────────────────

	ipcMain.handle(IPC.OPEN_EXTERNAL, (_event, url: string) => {
		void shell.openExternal(url);
	});

	// ── Voice preview ─────────────────────────────────────────────────────────

	ipcMain.handle(IPC.PREVIEW_VOICE, async (_event, opts: PreviewVoiceOpts) => {
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
				const buf = await res.arrayBuffer();
				return { audio: Buffer.from(buf).toString("base64") };
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
					`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=${googleKey}`,
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
			const buf = await res.arrayBuffer();
			return { audio: Buffer.from(buf).toString("base64") };
		} catch (e: unknown) {
			return { error: String(e) };
		}
	});

	// ── Narration style suggestion ───────────────────────────────────────────

	ipcMain.handle(
		IPC.SUGGEST_NARRATION_STYLE,
		async (_event, opts: SuggestNarrationStyleOpts) => {
			const { anthropicKey, openaiKey } = await getCredentials();
			if (!openaiKey) return { error: "OpenAI API key is required." };

			let provider: ReturnType<typeof detectMarkupProvider>;
			try {
				provider = detectMarkupProvider(anthropicKey || undefined, openaiKey);
			} catch (e) {
				return { error: (e as Error).message };
			}

			try {
				const { chapters, metadata } = await extractContent(opts.epubPath);
				const { excerpt } = findExcerpt(chapters);
				const anthropic = anthropicKey
					? new Anthropic({ apiKey: anthropicKey })
					: null;
				const openai = new OpenAI({ apiKey: openaiKey });
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
			} catch (e) {
				return { error: (e as Error).message };
			}
		},
	);

	// ── Conversion ────────────────────────────────────────────────────────────

	ipcMain.handle(
		IPC.START_CONVERSION,
		async (_event, opts: ConversionOptions) => {
			if (activeToken) return { error: "A conversion is already running." };

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

			const send = (channel: string, payload?: unknown) => {
				if (!win.isDestroyed()) win.webContents.send(channel, payload);
			};

			const inputExt = path.extname(opts.epubPath).toLowerCase();
			const inputSlug = safeFilename(path.basename(opts.epubPath, inputExt));
			const workDir = path.join("/tmp", "fennec-vox", inputSlug);
			const chaptersDir = path.join(workDir, "chapters");
			const narratorDir = path.join(workDir, "narrator");
			const outputFile = path.join(
				opts.outputDir,
				`${path.basename(opts.epubPath, inputExt)}.${opts.format}`,
			);
			const format = opts.format as TtsFormat;

			const token: CancellationToken = { cancelled: false };
			activeToken = token;

			void (async () => {
				try {
					await fs.ensureDir(opts.outputDir);
					await fs.ensureDir(chaptersDir);
					await fs.ensureDir(narratorDir);

					const progress: Progress = opts.redoTts
						? { completedChapters: {} }
						: await loadProgress(workDir);

					if (opts.redoTts) {
						const existing = await fs
							.readdir(chaptersDir)
							.catch(() => [] as string[]);
						await Promise.all(
							existing.map((f) => fs.remove(path.join(chaptersDir, f))),
						);
					}

					if (opts.resumeFrom !== undefined) {
						for (const key of Object.keys(progress.completedChapters)) {
							if (parseInt(key, 10) >= opts.resumeFrom)
								delete progress.completedChapters[Number(key)];
						}
					}

					const { chapters, metadata } = await extractContent(opts.epubPath);
					progress.epubFile = opts.epubPath;
					progress.bookTitle = metadata.title;
					progress.bookAuthor = metadata.author;
					progress.total = chapters.length;
					await saveProgress(workDir, progress);

					// Re-process chapters with a mismatched cached format
					const expectedExt = `.${innerTtsFormat(format, ttsProvider)}`;
					for (const ch of chapters) {
						const rec = progress.completedChapters[ch.index];
						if (rec && !rec.file.endsWith(expectedExt)) {
							delete progress.completedChapters[ch.index];
						}
					}

					const estimate = estimateCosts(
						chapters,
						progress.completedChapters,
						opts.chunkSize,
						opts.ttsModel,
						provider,
						ttsProvider,
					);
					const completedIndices = Object.keys(progress.completedChapters).map(
						Number,
					);
					send(IPC.CONVERSION_PROGRESS, {
						type: "start",
						provider,
						total: chapters.length,
						concurrency: opts.concurrency,
						completed: completedIndices,
					});
					send(
						IPC.CONVERSION_LOG,
						`Book: "${metadata.title}" by ${metadata.author}`,
					);
					send(
						IPC.CONVERSION_LOG,
						`Chapters: ${chapters.length}  |  Markup provider: ${provider}  |  TTS: ${ttsProvider}`,
					);
					send(
						IPC.CONVERSION_LOG,
						`Estimated cost: ~$${estimate.totalCost.toFixed(4)}`,
					);

					const anthropic = anthropicKey
						? new Anthropic({ apiKey: anthropicKey })
						: null;
					const openai = new OpenAI({
						apiKey: openaiKey || "unused",
					});
					const io = createNodeIO(
						chaptersDir,
						narratorDir,
						token,
						format,
						metadata.title,
						metadata.author,
						outputFile,
						send,
						ttsProvider,
					);

					const { assembled, chapterCount, total } = await runConversion({
						chapters,
						completedChapters: progress.completedChapters,
						provider,
						anthropic,
						openai,
						voice: opts.voice,
						format,
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
						bookTitle: metadata.title,
						bookAuthor: metadata.author,
						io,
						onChapterComplete: async (_ch: Chapter, _rec: ChapterRecord) => {
							await saveProgress(workDir, progress);
						},
					});

					if (token.cancelled) {
						send(IPC.CONVERSION_LOG, "Conversion stopped by user.");
						return;
					}

					// For m4b/m4a and Gemini WAV: onAssemble already wrote the file.
					// For other formats write it now.
					const innerFmtCheck = innerTtsFormat(format, ttsProvider);
					if (format !== "m4b" && format !== "m4a" && innerFmtCheck !== "wav") {
						await fs.writeFile(outputFile, assembled);
					}

					const stat = await fs.stat(outputFile);
					const totalMB = stat.size / 1024 / 1024;
					send(
						IPC.CONVERSION_LOG,
						`\nDone! Audiobook written to: ${outputFile}`,
					);
					send(
						IPC.CONVERSION_LOG,
						`Total size: ${totalMB.toFixed(2)} MB | Chapters: ${chapterCount}/${total}`,
					);
					send(IPC.CONVERSION_PROGRESS, {
						type: "complete",
						outputFile,
						totalMB,
						chapters: chapterCount,
						total,
					});
					send(IPC.CONVERSION_COMPLETE, {
						type: "complete",
						outputFile,
						totalMB,
						chapters: chapterCount,
						total,
					});
				} catch (e: unknown) {
					if (!token.cancelled) {
						send(IPC.CONVERSION_LOG, `[ERROR] ${(e as Error).message}`);
						send(IPC.CONVERSION_ERROR, (e as Error).message);
					}
				} finally {
					if (activeToken === token) activeToken = null;
				}
			})();

			return { ok: true };
		},
	);

	ipcMain.handle(IPC.STOP_CONVERSION, () => {
		if (activeToken) {
			activeToken.cancelled = true;
			activeToken = null;
			return { ok: true };
		}
		return { error: "No active conversion." };
	});
}
