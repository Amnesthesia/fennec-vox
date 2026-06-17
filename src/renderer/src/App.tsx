import type {
	ConversionOptions,
	ElevenLabsModel,
	ProgressEvent,
	TtsFormat,
	TtsModel,
	TtsProvider,
	TtsVoice,
} from "@shared/ipc";
import { useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_ELEVENLABS_VOICE_ID } from "../../lib/types";
import ConversionConfig from "./components/ConversionConfig";
import FilePicker from "./components/FilePicker";
import LogViewer from "./components/LogViewer";
import NarrationStyleModal from "./components/NarrationStyleModal";
import ProgressPanel from "./components/ProgressPanel";
import SettingsPanel from "./components/SettingsPanel";

export interface NarrationStyleSuggestionState {
	instructions: string;
	recognized: boolean;
	bookTitle: string;
	bookAuthor: string;
}

export interface ChapterStatus {
	index: number;
	title: string;
	status: "pending" | "ssml" | "tts" | "done" | "error";
}

export interface AppConversionState {
	running: boolean;
	provider: string;
	total: number;
	chapters: ChapterStatus[];
	doneCount: number;
	currentStep: string;
	outputFile?: string;
	errorMessage?: string;
	phase: "idle" | "running" | "done" | "error";
}

const INITIAL_STATE: AppConversionState = {
	running: false,
	provider: "",
	total: 0,
	chapters: [],
	doneCount: 0,
	currentStep: "",
	phase: "idle",
};

export default function App() {
	const [epubPath, setEpubPath] = useState("");
	const [outputDir, setOutputDir] = useState("");
	const [voice, setVoice] = useState<TtsVoice>("echo");
	const [format, setFormat] = useState<TtsFormat>("m4b");
	const [ttsModel, setTtsModel] = useState<TtsModel>("gpt-4o-mini-tts");
	const [chunkSize, setChunkSize] = useState(3000);
	const [concurrency, setConcurrency] = useState(4);
	const [ttsInstructions, setTtsInstructions] = useState(
		"You are a literary audiobook narrator. Speak with a mellow, warm baritone — measured and unhurried, never flat. Use subtle shifts in inflection and tempo to distinguish characters and carry emotional weight, not broad theatrical performance. For dialogue, let each voice emerge through slight tonal variation while keeping the overall register consistent. For reflective or philosophical passages, adopt a quieter, more pensive quality — slow down slightly and give the sentences space to breathe. Avoid dramatic pauses that feel staged. Treat punctuation honestly: commas are rests, paragraph breaks are longer ones. The listener should feel accompanied, not performed to.",
	);
	const [showSettings, setShowSettings] = useState(false);

	const [elevenLabsKey, setElevenLabsKey] = useState("");
	const [elevenLabsVoiceId, setElevenLabsVoiceId] = useState(
		DEFAULT_ELEVENLABS_VOICE_ID,
	);
	const [elevenLabsModel, setElevenLabsModel] =
		useState<ElevenLabsModel>("eleven_v3");
	const [ttsProvider, setTtsProvider] = useState<TtsProvider>("openai");

	// When the ElevenLabs key is cleared, revert to OpenAI automatically.
	useEffect(() => {
		if (!elevenLabsKey) setTtsProvider("openai");
	}, [elevenLabsKey]);

	const [hasOpenAiKey, setHasOpenAiKey] = useState<boolean | null>(null);
	const [keyInput, setKeyInput] = useState("");
	const [saving, setSaving] = useState(false);
	const [keyError, setKeyError] = useState("");

	const [convState, setConvState] = useState<AppConversionState>(INITIAL_STATE);
	const [logs, setLogs] = useState<string[]>([]);
	const logsRef = useRef<string[]>([]);

	const [narrationSuggestion, setNarrationSuggestion] =
		useState<NarrationStyleSuggestionState | null>(null);
	const suggestionGenRef = useRef(0);

	const appendLog = useCallback((line: string) => {
		logsRef.current = [...logsRef.current, line];
		setLogs([...logsRef.current]);
	}, []);

	useEffect(() => {
		void window.api.getCredentials().then((creds) => {
			setHasOpenAiKey(!!creds.openaiKey);
			setElevenLabsKey(creds.elevenLabsKey);
			if (creds.elevenLabsKey) setTtsProvider("elevenlabs");
		});
	}, []);

	const handleSaveKey = async () => {
		const key = keyInput.trim();
		if (!key.startsWith("sk-")) {
			setKeyError("Key should start with sk-");
			return;
		}
		setSaving(true);
		setKeyError("");
		const existing = await window.api.getCredentials();
		await window.api.saveCredentials({ ...existing, openaiKey: key });
		setSaving(false);
		setHasOpenAiKey(true);
	};

	const handleEpubChange = (p: string) => {
		setEpubPath(p);
		if (p && !outputDir) {
			const dir = p.replace(/[/\\][^/\\]+$/, "");
			if (dir) setOutputDir(dir);
		}

		// Only OpenAI's gpt-4o-mini-tts model accepts narration "instructions" —
		// ElevenLabs and tts-1/tts-1-hd have no equivalent, so skip the suggestion
		// entirely rather than computing one that couldn't be used.
		const gen = ++suggestionGenRef.current;
		setNarrationSuggestion(null);
		if (p && ttsProvider === "openai" && ttsModel === "gpt-4o-mini-tts") {
			void window.api
				.suggestNarrationStyle({ epubPath: p })
				.then((result) => {
					if (gen !== suggestionGenRef.current) return;
					if (result.error || !result.instructions) return;
					setNarrationSuggestion({
						instructions: result.instructions,
						recognized: !!result.recognized,
						bookTitle: result.bookTitle ?? "",
						bookAuthor: result.bookAuthor ?? "",
					});
				})
				.catch(() => {});
		}
	};

	const applyProgress = useCallback((event: ProgressEvent) => {
		setConvState((prev) => {
			switch (event.type) {
				case "start": {
					const doneSet = new Set(event.completed);
					const chapters = Array.from({ length: event.total }, (_, i) => ({
						index: i,
						title: `Chapter ${i + 1}`,
						status: (doneSet.has(i)
							? "done"
							: "pending") as ChapterStatus["status"],
					}));
					return {
						...prev,
						running: true,
						provider: event.provider,
						total: event.total,
						phase: "running",
						currentStep: "Starting…",
						doneCount: doneSet.size,
						chapters,
					};
				}
				case "chapter_begin": {
					const chapters = prev.chapters.map((c) =>
						c.index === event.index
							? { ...c, title: event.title, status: "ssml" as const }
							: c,
					);
					return {
						...prev,
						chapters,
						currentStep: `Chapter ${event.index + 1}: SSML markup…`,
					};
				}
				case "chapter_ssml": {
					const chapters = prev.chapters.map((c) =>
						c.index === event.index ? { ...c, status: "ssml" as const } : c,
					);
					return { ...prev, chapters };
				}
				case "chapter_tts": {
					const chapters = prev.chapters.map((c) =>
						c.index === event.index ? { ...c, status: "tts" as const } : c,
					);
					return {
						...prev,
						chapters,
						currentStep: `Chapter ${event.index + 1}: TTS synthesis (${event.chunks} chunk(s))…`,
					};
				}
				case "chapter_done": {
					const chapters = prev.chapters.map((c) =>
						c.index === event.index ? { ...c, status: "done" as const } : c,
					);
					const doneCount = chapters.filter((c) => c.status === "done").length;
					return { ...prev, chapters, doneCount };
				}
				case "assembly":
					return { ...prev, currentStep: "Assembling final audiobook…" };
				case "complete":
					return {
						...prev,
						running: false,
						phase: "done",
						doneCount: event.chapters,
						outputFile: event.outputFile,
						currentStep: `Done — ${event.totalMB.toFixed(1)} MB`,
					};
				case "error":
					return {
						...prev,
						running: false,
						phase: "error",
						errorMessage: event.message,
					};
				default:
					return prev;
			}
		});
	}, []);

	useEffect(() => {
		const unsubs = [
			window.api.onProgress(applyProgress),
			window.api.onLog(appendLog),
			window.api.onError((msg) => {
				appendLog(`[ERROR] ${msg}`);
				setConvState((prev) => ({
					...prev,
					running: false,
					phase: "error",
					errorMessage: msg,
				}));
			}),
		];
		return () =>
			unsubs.forEach((u) => {
				u();
			});
	}, [applyProgress, appendLog]);

	const handleStart = async (redoTts = false) => {
		if (!epubPath) return;
		logsRef.current = [];
		setLogs([]);
		setConvState(INITIAL_STATE);

		const opts: ConversionOptions = {
			epubPath,
			outputDir: outputDir || "./audiobook-output",
			voice,
			format,
			ttsModel,
			ttsProvider,
			chunkSize,
			concurrency,
			ttsInstructions: ttsInstructions || undefined,
			redoTts: redoTts || undefined,
			elevenLabsVoiceId:
				ttsProvider === "elevenlabs" ? elevenLabsVoiceId : undefined,
			elevenLabsModel:
				ttsProvider === "elevenlabs" ? elevenLabsModel : undefined,
		};
		const result = await window.api.startConversion(opts);
		console.debug("Conversion start result:", result);
		if (result.error) {
			appendLog(`[ERROR] ${result.error}`);
			setConvState((prev) => ({
				...prev,
				phase: "error",
				errorMessage: result.error,
			}));
		}
	};

	const handleStop = async () => {
		await window.api.stopConversion();
		setConvState((prev) => ({ ...prev, running: false, phase: "idle" }));
	};

	const canStart = !!epubPath && !convState.running;

	// Loading
	if (hasOpenAiKey === null) {
		return <div className="app" />;
	}

	// Setup gate — no key yet
	if (hasOpenAiKey === false) {
		return (
			<div className="app">
				<div className="titlebar" />
				<div className="setup-gate">
					<div className="setup-card">
						<div className="setup-logo">&nbsp;</div>
						<p className="setup-sub">
							<b>Fennec Vox</b> uses the OpenAI API for text-to-speech
							synthesis. Paste your API key below to get started — it will be
							stored securely in your system keychain.
						</p>
						<a
							className="setup-ext-link"
							onClick={() =>
								void window.api.openExternal(
									"https://platform.openai.com/api-keys",
								)
							}
						>
							Get your API key at platform.openai.com →
						</a>
						<div className="setup-field">
							<input
								type="password"
								className="setup-key-input"
								placeholder="sk-…"
								value={keyInput}
								onChange={(e) => {
									setKeyInput(e.target.value);
									setKeyError("");
								}}
								onKeyDown={(e) => e.key === "Enter" && void handleSaveKey()}
								spellCheck={false}
								autoComplete="off"
							/>
							{keyError && <span className="setup-key-error">{keyError}</span>}
						</div>
						<button
							className="btn btn-primary setup-btn"
							type="button"
							onClick={() => void handleSaveKey()}
							disabled={saving || !keyInput.trim()}
						>
							{saving ? "Saving…" : "Save & continue"}
						</button>
					</div>
				</div>

				{showSettings && (
					<SettingsPanel
						onClose={() => {
							setShowSettings(false);
							void window.api.getCredentials().then((creds) => {
								setHasOpenAiKey(!!creds.openaiKey);
								setElevenLabsKey(creds.elevenLabsKey);
								if (creds.elevenLabsKey && ttsProvider === "openai")
									setTtsProvider("elevenlabs");
							});
						}}
					/>
				)}
			</div>
		);
	}

	return (
		<div className="app">
			<div className="titlebar">
				<div className="titlebar-actions">
					<button
						className="btn-icon"
						onClick={() => setShowSettings(true)}
						title="Settings"
					>
						⚙
					</button>
				</div>
			</div>

			<div className="body">
				<aside className="sidebar">
					<div className="section">
						<div className="section-label">Book File</div>
						<FilePicker
							value={epubPath}
							onChange={handleEpubChange}
							onPickDir={async () => {
								const dir = await window.api.selectOutputDir();
								if (dir) setOutputDir(dir);
							}}
						/>
					</div>

					<ConversionConfig
						voice={voice}
						onVoiceChange={setVoice}
						format={format}
						onFormatChange={setFormat}
						ttsModel={ttsModel}
						onTtsModelChange={setTtsModel}
						chunkSize={chunkSize}
						onChunkSizeChange={setChunkSize}
						concurrency={concurrency}
						onConcurrencyChange={setConcurrency}
						ttsInstructions={ttsInstructions}
						onTtsInstructionsChange={setTtsInstructions}
						ttsProvider={ttsProvider}
						onTtsProviderChange={setTtsProvider}
						hasElevenLabsKey={!!elevenLabsKey}
						elevenLabsVoiceId={elevenLabsVoiceId}
						onElevenLabsVoiceIdChange={setElevenLabsVoiceId}
						elevenLabsModel={elevenLabsModel}
						onElevenLabsModelChange={setElevenLabsModel}
					/>

					<div
						className="section"
						style={{ marginTop: "auto", paddingTop: 12 }}
					>
						{convState.running ? (
							<button className="btn btn-danger btn-full" onClick={handleStop}>
								⏹ Stop Conversion
							</button>
						) : (
							<>
								<button
									className="btn btn-primary btn-full"
									onClick={() => void handleStart()}
									disabled={!canStart}
									title={!epubPath ? "Select a book first" : undefined}
								>
									▶ Convert to Audiobook
								</button>
								{(convState.phase === "done" || convState.phase === "error") &&
									epubPath && (
										<button
											className="btn btn-secondary btn-full"
											style={{ marginTop: 6 }}
											onClick={() => void handleStart(true)}
										>
											↺ Redo TTS only
										</button>
									)}
							</>
						)}
					</div>
				</aside>

				<main className="main">
					<ProgressPanel state={convState} />
					<LogViewer lines={logs} />
				</main>
			</div>

			{showSettings && (
				<SettingsPanel
					onClose={() => {
						setShowSettings(false);
						void window.api.getCredentials().then((creds) => {
							setHasOpenAiKey(!!creds.openaiKey);
							setElevenLabsKey(creds.elevenLabsKey);
							// If ElevenLabs key was just added, switch to it by default.
							if (creds.elevenLabsKey && ttsProvider === "openai")
								setTtsProvider("elevenlabs");
						});
					}}
				/>
			)}

			{narrationSuggestion && (
				<NarrationStyleModal
					suggestion={narrationSuggestion}
					onAccept={() => {
						setTtsInstructions(narrationSuggestion.instructions);
						setNarrationSuggestion(null);
					}}
					onDecline={() => setNarrationSuggestion(null)}
				/>
			)}
		</div>
	);
}
