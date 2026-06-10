import { type ChildProcess, spawn } from "node:child_process";
import path from "node:path";
import type { ConversionOptions, TtsModel, TtsVoice } from "@shared/ipc";
import { IPC } from "@shared/ipc";
import { type BrowserWindow, dialog, ipcMain, shell } from "electron";
import { getCredentials, saveCredentials } from "./keychain";

let activeProcess: ChildProcess | null = null;

function resolveScriptPath(): string {
	if (process.env.NODE_ENV === "development") {
		return path.resolve(__dirname, "../../dist/cli/convert.js");
	}
	return path.join(process.resourcesPath, "convert.js");
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

	ipcMain.handle(
		IPC.SAVE_CREDENTIALS,
		(_event, creds: { anthropicKey: string; openaiKey: string }) => {
			return saveCredentials(creds);
		},
	);

	// ── Open external URL ─────────────────────────────────────────────────────

	ipcMain.handle(IPC.OPEN_EXTERNAL, (_event, url: string) => {
		void shell.openExternal(url);
	});

	// ── Voice preview ─────────────────────────────────────────────────────────

	ipcMain.handle(
		IPC.PREVIEW_VOICE,
		async (
			_event,
			opts: { voice: TtsVoice; model: TtsModel; instructions?: string },
		) => {
			const { openaiKey } = await getCredentials();
			if (!openaiKey) return { error: "No OpenAI key configured." };
			try {
				const body: Record<string, unknown> = {
					model: opts.model,
					input: `Hey there, I'm ${opts.voice}. I'll be your narrator for this audiobook.`,
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
		},
	);

	// ── Conversion ────────────────────────────────────────────────────────────

	ipcMain.handle(
		IPC.START_CONVERSION,
		async (_event, opts: ConversionOptions) => {
			if (activeProcess) return { error: "A conversion is already running." };

			const { anthropicKey, openaiKey } = await getCredentials();
			if (!openaiKey) {
				return {
					error: "OpenAI API key is required. Configure it in Settings.",
				};
			}

			const scriptPath = resolveScriptPath();

			const args: string[] = [
				scriptPath,
				opts.epubPath,
				"--voice",
				opts.voice,
				"--format",
				opts.format,
				"--tts-model",
				opts.ttsModel,
				"--chunk-size",
				String(opts.chunkSize),
				"--concurrency",
				String(opts.concurrency),
				"--output-dir",
				opts.outputDir,
				"--yes",
			];
			if (opts.resumeFrom !== undefined) {
				args.push("--resume-from", String(opts.resumeFrom));
			}
			if (opts.ttsInstructions) {
				args.push("--tts-instructions", opts.ttsInstructions);
			}
			if (opts.redoTts) {
				args.push("--redo-tts");
			}

			const env: NodeJS.ProcessEnv = {
				...process.env,
				ELECTRON_RUN_AS_NODE: "1",
				OPENAI_API_KEY: openaiKey,
				...(anthropicKey ? { ANTHROPIC_API_KEY: anthropicKey } : {}),
			};

			activeProcess = spawn(process.execPath, args, { env });

			const send = (channel: string, payload?: unknown) => {
				if (win.isDestroyed()) return;
				win.webContents.send(channel, payload);
			};

			activeProcess.stdout?.on("data", (chunk: Buffer) => {
				const lines = chunk.toString().split("\n").filter(Boolean);
				for (const line of lines) {
					if (line.startsWith("[PROGRESS] ")) {
						try {
							const event = JSON.parse(line.slice("[PROGRESS] ".length));
							send(IPC.CONVERSION_PROGRESS, event);
							if (event.type === "complete")
								send(IPC.CONVERSION_COMPLETE, event);
						} catch {
							/* malformed JSON — treat as plain log */
						}
					} else {
						send(IPC.CONVERSION_LOG, line);
					}
				}
			});

			activeProcess.stderr?.on("data", (chunk: Buffer) => {
				send(IPC.CONVERSION_LOG, chunk.toString());
			});

			activeProcess.on("close", (code) => {
				activeProcess = null;
				if (code !== 0)
					send(
						IPC.CONVERSION_ERROR,
						`Process exited with code ${code ?? "unknown"}`,
					);
			});

			return { ok: true };
		},
	);

	ipcMain.handle(IPC.STOP_CONVERSION, () => {
		if (activeProcess) {
			activeProcess.kill("SIGTERM");
			activeProcess = null;
			return { ok: true };
		}
		return { error: "No active conversion." };
	});
}
