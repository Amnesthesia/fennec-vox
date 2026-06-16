import type {
	ElevenLabsModel,
	TtsFormat,
	TtsModel,
	TtsProvider,
	TtsVoice,
} from "@shared/ipc";
import { useEffect, useRef, useState } from "react";
import { ELEVENLABS_VOICES } from "../../../lib/types";

const ALL_VOICES: TtsVoice[] = [
	"alloy",
	"ash",
	"ballad",
	"coral",
	"echo",
	"fable",
	"nova",
	"onyx",
	"sage",
	"shimmer",
	"verse",
];
const MINI_TTS_ONLY: TtsVoice[] = ["ballad", "verse"];

let manifestCache: Record<string, string[]> | null = null;
async function getManifest(): Promise<Record<string, string[]>> {
	if (manifestCache) return manifestCache;
	const res = await fetch("./previews/manifest.json");
	manifestCache = (await res.json()) as Record<string, string[]>;
	return manifestCache;
}

interface Props {
	voice: TtsVoice;
	onVoiceChange: (v: TtsVoice) => void;
	format: TtsFormat;
	onFormatChange: (v: TtsFormat) => void;
	ttsModel: TtsModel;
	onTtsModelChange: (v: TtsModel) => void;
	chunkSize: number;
	onChunkSizeChange: (v: number) => void;
	concurrency: number;
	onConcurrencyChange: (v: number) => void;
	ttsInstructions: string;
	onTtsInstructionsChange: (v: string) => void;
	ttsProvider: TtsProvider;
	elevenLabsVoiceId: string;
	onElevenLabsVoiceIdChange: (v: string) => void;
	elevenLabsModel: ElevenLabsModel;
	onElevenLabsModelChange: (v: ElevenLabsModel) => void;
}

function slugToTitle(slug: string): string {
	return slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export default function ConversionConfig({
	voice,
	onVoiceChange,
	format,
	onFormatChange,
	ttsModel,
	onTtsModelChange,
	chunkSize,
	onChunkSizeChange,
	concurrency,
	onConcurrencyChange,
	ttsInstructions,
	onTtsInstructionsChange,
	ttsProvider,
	elevenLabsVoiceId,
	onElevenLabsVoiceIdChange,
	elevenLabsModel,
	onElevenLabsModelChange,
}: Props) {
	const [showAdvanced, setShowAdvanced] = useState(false);
	const [previewing, setPreviewing] = useState(false);
	const [synthesizing, setSynthesizing] = useState(false);
	const [showPoems, setShowPoems] = useState(false);
	const [poems, setPoems] = useState<string[]>([]);
	const [poemTexts, setPoemTexts] = useState<Record<string, string>>({});
	const audioRef = useRef<HTMLAudioElement | null>(null);
	const popoverRef = useRef<HTMLDivElement | null>(null);
	const elPreviewCache = useRef<Map<string, string>>(new Map());

	// Update poem list when voice changes
	useEffect(() => {
		getManifest()
			.then((m) => setPoems(m[voice] ?? []))
			.catch(() => {});
	}, [voice]);

	// Load poem texts once — used to synthesise live ElevenLabs previews
	useEffect(() => {
		fetch("./previews/poems.json")
			.then((res) => res.json())
			.then((data: Record<string, string>) => setPoemTexts(data))
			.catch(() => {});
	}, []);

	// Close popover on outside click
	useEffect(() => {
		if (!showPoems) return;
		const handler = (e: MouseEvent) => {
			if (
				popoverRef.current &&
				!popoverRef.current.contains(e.target as Node)
			) {
				setShowPoems(false);
			}
		};
		document.addEventListener("mousedown", handler);
		return () => document.removeEventListener("mousedown", handler);
	}, [showPoems]);

	const playSlug = (v: TtsVoice, slug: string) => {
		if (audioRef.current) {
			audioRef.current.pause();
			audioRef.current = null;
		}
		setPreviewing(true);
		const audio = new Audio(`./previews/${v}/${slug}.mp3`);
		audioRef.current = audio;
		audio.play().catch(() => {});
		audio.onended = () => setPreviewing(false);
		audio.onerror = () => setPreviewing(false);
	};

	const handleVoiceChange = async (v: TtsVoice) => {
		onVoiceChange(v);
		const manifest = await getManifest().catch(() => null);
		const slugs = manifest?.[v] ?? [];
		if (slugs.length === 0) return;
		playSlug(v, slugs[Math.floor(Math.random() * slugs.length)]!);
	};

	// ElevenLabs voices have no pre-rendered previews, so synthesise the poem
	// live via the ElevenLabs API (cached per voice/model/poem for this session).
	const playElevenLabsPoem = async (voiceId: string, slug: string) => {
		const text = poemTexts[slug];
		if (!text || !voiceId) return;
		if (audioRef.current) {
			audioRef.current.pause();
			audioRef.current = null;
		}
		const playBase64 = (audio64: string) => {
			setPreviewing(true);
			const audio = new Audio(`data:audio/mpeg;base64,${audio64}`);
			audioRef.current = audio;
			audio.play().catch(() => {});
			audio.onended = () => setPreviewing(false);
			audio.onerror = () => setPreviewing(false);
		};

		const cacheKey = `${voiceId}|${elevenLabsModel}|${slug}`;
		const cached = elPreviewCache.current.get(cacheKey);
		if (cached) {
			playBase64(cached);
			return;
		}

		setSynthesizing(true);
		try {
			const result = await window.api.previewVoice({
				ttsProvider: "elevenlabs",
				text,
				elevenLabsVoiceId: voiceId,
				elevenLabsModel,
			});
			setSynthesizing(false);
			if (result.error || !result.audio) return;
			elPreviewCache.current.set(cacheKey, result.audio);
			playBase64(result.audio);
		} catch {
			setSynthesizing(false);
		}
	};

	const handleElevenLabsVoiceChange = (id: string) => {
		onElevenLabsVoiceIdChange(id);
		const slugs = Object.keys(poemTexts);
		if (slugs.length === 0) return;
		void playElevenLabsPoem(
			id,
			slugs[Math.floor(Math.random() * slugs.length)]!,
		);
	};

	return (
		<>
			{ttsProvider === "elevenlabs" ? (
				<div className="section">
					<div className="section-label">
						Voice
						{synthesizing && (
							<span className="preview-badge">⏳ synthesizing…</span>
						)}
						{!synthesizing && previewing && (
							<span className="preview-badge">▶ playing</span>
						)}
					</div>
					<div className="field">
						<div
							style={{
								display: "flex",
								gap: 6,
								alignItems: "center",
								position: "relative",
							}}
						>
							<select
								style={{ flex: 1 }}
								value={
									ELEVENLABS_VOICES.some((v) => v.id === elevenLabsVoiceId)
										? elevenLabsVoiceId
										: "__custom__"
								}
								onChange={(e) => {
									const val = e.target.value;
									if (val === "__custom__") {
										onElevenLabsVoiceIdChange("");
										return;
									}
									handleElevenLabsVoiceChange(val);
								}}
							>
								{ELEVENLABS_VOICES.map((v) => (
									<option key={v.id} value={v.id}>
										{v.name}
									</option>
								))}
								<option value="__custom__">Custom voice ID…</option>
							</select>

							<button
								className="btn-icon"
								title="Preview a specific poem"
								style={{ fontSize: 14, padding: "4px 6px", flexShrink: 0 }}
								onClick={() => setShowPoems((v) => !v)}
							>
								▶
							</button>

							{showPoems && (
								<div className="poem-popover" ref={popoverRef}>
									{Object.keys(poemTexts).map((slug) => (
										<button
											key={slug}
											className="poem-popover-item"
											onClick={() => {
												void playElevenLabsPoem(elevenLabsVoiceId, slug);
												setShowPoems(false);
											}}
										>
											{slugToTitle(slug)}
										</button>
									))}
								</div>
							)}
						</div>
						{!ELEVENLABS_VOICES.some((v) => v.id === elevenLabsVoiceId) && (
							<input
								style={{ marginTop: 6 }}
								value={elevenLabsVoiceId}
								onChange={(e) => onElevenLabsVoiceIdChange(e.target.value)}
								placeholder="Paste ElevenLabs voice ID…"
								spellCheck={false}
								autoComplete="off"
							/>
						)}
					</div>
				</div>
			) : (
				<div className="section">
					<div className="section-label">
						Voice
						{previewing && <span className="preview-badge">▶ playing</span>}
					</div>
					<div className="field">
						<div
							style={{
								display: "flex",
								gap: 6,
								alignItems: "center",
								position: "relative",
							}}
						>
							<select
								style={{ flex: 1 }}
								value={voice}
								onChange={(e) =>
									void handleVoiceChange(e.target.value as TtsVoice)
								}
							>
								{ALL_VOICES.filter(
									(v) =>
										ttsModel === "gpt-4o-mini-tts" ||
										!MINI_TTS_ONLY.includes(v),
								).map((v) => (
									<option key={v} value={v}>
										{v.charAt(0).toUpperCase() + v.slice(1)}
									</option>
								))}
							</select>

							<button
								className="btn-icon"
								title="Preview a specific poem"
								style={{ fontSize: 14, padding: "4px 6px", flexShrink: 0 }}
								onClick={() => setShowPoems((v) => !v)}
							>
								▶
							</button>

							{showPoems && (
								<div className="poem-popover" ref={popoverRef}>
									{poems.map((slug) => (
										<button
											key={slug}
											className="poem-popover-item"
											onClick={() => {
												playSlug(voice, slug);
												setShowPoems(false);
											}}
										>
											{slugToTitle(slug)}
										</button>
									))}
								</div>
							)}
						</div>
					</div>
				</div>
			)}

			<div className="section">
				<button
					className="advanced-toggle"
					type="button"
					onClick={() => setShowAdvanced((v) => !v)}
				>
					<span>Advanced</span>
					<span className="chevron">{showAdvanced ? "▲" : "▼"}</span>
				</button>

				{showAdvanced && (
					<>
						<div className="field" style={{ marginTop: 10 }}>
							<label>Format</label>
							<select
								value={format}
								onChange={(e) => onFormatChange(e.target.value as TtsFormat)}
							>
								{(
									[
										["m4b", "M4B — Audiobook (chapters)"],
										["m4a", "M4A — Audio"],
										["mp3", "MP3"],
										["aac", "AAC"],
										["opus", "Opus"],
										["flac", "FLAC"],
									] as [TtsFormat, string][]
								).map(([f, label]) => (
									<option key={f} value={f}>
										{label}
									</option>
								))}
							</select>
						</div>
						{ttsProvider === "elevenlabs" ? (
							<div className="field">
								<label>ElevenLabs Model</label>
								<select
									value={elevenLabsModel}
									onChange={(e) =>
										onElevenLabsModelChange(e.target.value as ElevenLabsModel)
									}
								>
									<option value="eleven_v3">
										Eleven v3 — richest narration (audio tags)
									</option>
									<option value="eleven_multilingual_v2">
										Eleven Multilingual v2 (SSML breaks)
									</option>
									<option value="eleven_flash_v2_5">
										Eleven Flash v2.5 — fastest (SSML breaks)
									</option>
								</select>
							</div>
						) : (
							<div className="field">
								<label>Text-to-Speech Model</label>
								<select
									value={ttsModel}
									onChange={(e) => {
										const m = e.target.value as TtsModel;
										onTtsModelChange(m);
										if (
											m !== "gpt-4o-mini-tts" &&
											MINI_TTS_ONLY.includes(voice)
										) {
											onVoiceChange("alloy");
										}
									}}
								>
									<option value="tts-1">Standard (tts-1)</option>
									<option value="tts-1-hd">High Quality (tts-1-hd)</option>
									<option value="gpt-4o-mini-tts">GPT-4o Mini TTS</option>
								</select>
							</div>
						)}
						{ttsProvider === "openai" && ttsModel === "gpt-4o-mini-tts" && (
							<div className="field">
								<label>Narration style</label>
								<textarea
									rows={3}
									placeholder="Warm, measured audiobook narrator. Speak clearly with natural pacing."
									value={ttsInstructions}
									onChange={(e) => onTtsInstructionsChange(e.target.value)}
									spellCheck={false}
									style={{ resize: "vertical", width: "100%" }}
								/>
							</div>
						)}
						<div className="field">
							<label>Chunk size (chars)</label>
							<input
								type="number"
								value={chunkSize}
								min={500}
								max={8000}
								step={500}
								onChange={(e) => onChunkSizeChange(Number(e.target.value))}
							/>
							<p className="field-note">
								Controls the max size of each paragraph chunk to process
							</p>
						</div>
						<div className="field">
							<label>Parallelization factor</label>
							<input
								type="number"
								value={concurrency}
								min={1}
								max={8}
								step={1}
								onChange={(e) => onConcurrencyChange(Number(e.target.value))}
							/>
							<p className="field-note">
								Controls the number of chunks processed in parallel. Higher
								values may increase speed but also CPU usage.
							</p>
						</div>
					</>
				)}
			</div>
		</>
	);
}
