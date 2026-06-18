#!/usr/bin/env node

/**
 * Generates a TTS preview MP3 for every voice × poem combination and saves them to
 * src/renderer/public/previews/<voice>/<poem-slug>.mp3
 *
 * OpenAI voices use the gpt-4o-mini-tts model.
 * ElevenLabs built-in voices use eleven_multilingual_v2 (voice IDs are used as
 * directory names so the app can look them up by the same ID used for synthesis).
 * Gemini voices use gemini-2.5-flash-preview-tts; WAV output is converted to MP3
 * via ffmpeg-static so the static files stay in a uniform format.
 *
 * Usage:
 *   pnpm run generate-previews          # skip already-cached files
 *   pnpm run generate-previews --force  # regenerate everything
 *   pnpm run generate-previews --skip-elevenlabs  # OpenAI only
 *   pnpm run generate-previews --skip-gemini      # skip Gemini voices
 *
 * Poems are read from scripts/poems/*.txt — the filename (without .txt) is used
 * as the slug and the file content is sent to the TTS API verbatim.
 *
 * After generation a manifest.json is written to the previews directory so the
 * app knows which slugs are available for each voice/voiceId without needing
 * filesystem access at runtime.
 *
 * Reads keys from env vars (OPENAI_API_KEY / ELEVENLABS_API_KEY / GEMINI_API_KEY
 * or GOOGLE_API_KEY) or the system keychain (same store the app uses). Gemini
 * generation is skipped gracefully if no key is found.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import fs from "fs-extra";

const SERVICE = "Fennec Vox";
const OPENAI_MODEL = "gpt-4o-mini-tts";
const ELEVENLABS_MODEL = "eleven_multilingual_v2";
const POEMS_DIR = path.resolve(__dirname, "poems");
const OUT_DIR = path.resolve(__dirname, "../src/renderer/public/previews");

const OPENAI_VOICES = [
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
] as const;

// Must stay in sync with ELEVENLABS_VOICES in src/lib/types.ts
const ELEVENLABS_VOICES: { id: string; name: string }[] = [
	{ id: "21m00Tcm4TlvDq8ikWAM", name: "Rachel" },
	{ id: "pNInz6obpgDQGcFmaJgB", name: "Adam" },
	{ id: "ErXwobaYiN019PkySvjV", name: "Antoni" },
	{ id: "EXAVITQu4vr4xnSDxMaL", name: "Bella" },
	{ id: "AZnzlk1XvdvUeBnXmlld", name: "Domi" },
	{ id: "MF3mGyEYCl7XYWbV9V6O", name: "Elli" },
	{ id: "TxGEqnHWrfWFTfGW9XjX", name: "Josh" },
	{ id: "VR6AewLTigWG4xSOukaG", name: "Arnold" },
	{ id: "yoZ06aMxZJJ28mfd3POQ", name: "Sam" },
];

// Must stay in sync with GEMINI_VOICES in src/lib/types.ts
const GEMINI_VOICES: { name: string; label: string }[] = [
	{ name: "Charon", label: "Charon" },
	{ name: "Aoede", label: "Aoede" },
	{ name: "Fenrir", label: "Fenrir" },
	{ name: "Kore", label: "Kore" },
	{ name: "Puck", label: "Puck" },
	{ name: "Zephyr", label: "Zephyr" },
	{ name: "Leda", label: "Leda" },
	{ name: "Orus", label: "Orus" },
];

const force = process.argv.includes("--force");
const skipElevenLabs = process.argv.includes("--skip-elevenlabs");
const skipGemini =
	process.argv.includes("--skip-gemini") ||
	process.argv.includes("--skip-google");
const concurrency = parseInt(
	process.argv.find((a) => a.startsWith("--concurrency="))?.split("=")[1] ??
		"8",
	10,
);

// ─────────────────────────────────────────────────────────────────────────────

function loadKeytar() {
	// Lazy-load keytar so an arch mismatch only fails when actually needed.
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	return (
		(require("keytar") as typeof import("keytar")).default ?? require("keytar")
	);
}

async function getOpenAiKey(): Promise<string> {
	if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
	const keytar = loadKeytar();
	const key = await keytar.getPassword(SERVICE, "openai-api-key");
	if (!key)
		throw new Error(
			"No OpenAI API key found in keychain. Set OPENAI_API_KEY env var or save a key in the app first.",
		);
	return key;
}

async function getElevenLabsKey(): Promise<string | null> {
	if (process.env.ELEVENLABS_API_KEY) return process.env.ELEVENLABS_API_KEY;
	try {
		const keytar = loadKeytar();
		return await keytar.getPassword(SERVICE, "elevenlabs-api-key");
	} catch {
		return null;
	}
}

async function getGeminiKey(): Promise<string | null> {
	if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
	if (process.env.GOOGLE_API_KEY) return process.env.GOOGLE_API_KEY;
	try {
		const keytar = loadKeytar();
		return await keytar.getPassword(SERVICE, "google-api-key");
	} catch {
		return null;
	}
}

function resolveFfmpegBin(): string {
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const p = (require as (id: string) => string | null)("ffmpeg-static");
		if (p) return p;
	} catch {
		/* not installed */
	}
	return "ffmpeg";
}

async function convertWavToMp3(wavBuf: Buffer): Promise<Buffer> {
	const ffmpeg = resolveFfmpegBin();
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		const proc = spawn(
			ffmpeg,
			[
				"-f",
				"wav",
				"-i",
				"pipe:0",
				"-codec:a",
				"libmp3lame",
				"-qscale:a",
				"2",
				"-f",
				"mp3",
				"pipe:1",
			],
			{ stdio: ["pipe", "pipe", "ignore"] },
		);
		proc.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
		proc.on("close", (code) => {
			if (code !== 0) reject(new Error(`ffmpeg exited with code ${code}`));
			else resolve(Buffer.concat(chunks));
		});
		proc.on("error", reject);
		proc.stdin?.end(wavBuf);
	});
}

interface Poem {
	slug: string;
	text: string;
}

async function loadPoems(): Promise<Poem[]> {
	const files = (await fs.readdir(POEMS_DIR))
		.filter((f) => f.endsWith(".txt"))
		.sort();
	return Promise.all(
		files.map(async (f) => ({
			slug: f.slice(0, -4),
			text: (await fs.readFile(path.join(POEMS_DIR, f), "utf8")).trim(),
		})),
	);
}

const instructions = `You are reading a poem aloud. Speak with a warm, mellow baritone — measured and unhurried, never flat.
Treat the line break as a unit of breath: pause briefly at the end of each line even when the sentence runs on, but don't drop or settle until the sentence resolves. Give stanza breaks more space than line breaks. Let enjambment carry a slight forward lean in the voice.
Feel the poem's pulse without hammering it. In metered verse, the rhythm is there — ride it. In free verse, find the rhythm through phrasing and stress rather than flattening it into prose. On repetition or refrain, return with a slightly warmer or more settled tone, not mechanical repetition.
For lyric or confessional passages, pull back to a quieter, interior quality — close in, as if thinking aloud. For elegies, slow down and let silences carry weight.
Punctuation is real: a comma is a rest, a dash is a hitch or pivot, a period is a full landing. Where there is no punctuation, let syntax and breath guide you. No inserted pauses for effect — only what the text earns.
The listener should feel the poem given room to exist. Not explained, not dramatised, not rushed.`;

async function generateOpenAiOne(
	apiKey: string,
	voice: string,
	poem: Poem,
): Promise<void> {
	const outFile = path.join(OUT_DIR, voice, `${poem.slug}.mp3`);

	if (!force && (await fs.pathExists(outFile))) {
		console.log(`  skip   ${voice}/${poem.slug}`);
		return;
	}

	const res = await fetch("https://api.openai.com/v1/audio/speech", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			model: OPENAI_MODEL,
			voice,
			input: poem.text,
			response_format: "mp3",
			instructions,
		}),
	});

	if (!res.ok) {
		throw new Error(`API error ${res.status} ${res.statusText}`);
	}

	const buf = Buffer.from(await res.arrayBuffer());
	await fs.ensureDir(path.dirname(outFile));
	await fs.writeFile(outFile, buf);
	console.log(
		`  done   ${voice}/${poem.slug}  (${(buf.length / 1024).toFixed(0)} KB)`,
	);
}

async function generateElevenLabsOne(
	apiKey: string,
	voiceId: string,
	voiceName: string,
	poem: Poem,
): Promise<void> {
	const outFile = path.join(OUT_DIR, voiceId, `${poem.slug}.mp3`);

	if (!force && (await fs.pathExists(outFile))) {
		console.log(`  skip   ${voiceName}/${poem.slug}`);
		return;
	}

	const res = await fetch(
		`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`,
		{
			method: "POST",
			headers: {
				"xi-api-key": apiKey,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				text: poem.text,
				model_id: ELEVENLABS_MODEL,
			}),
		},
	);

	if (!res.ok) {
		const errBody = await res.text().catch(() => "");
		throw new Error(
			`ElevenLabs API error ${res.status} ${res.statusText}: ${errBody}`,
		);
	}

	const buf = Buffer.from(await res.arrayBuffer());
	await fs.ensureDir(path.dirname(outFile));
	await fs.writeFile(outFile, buf);
	console.log(
		`  done   ${voiceName}/${poem.slug}  (${(buf.length / 1024).toFixed(0)} KB)`,
	);
}

async function generateGeminiOne(
	apiKey: string,
	voiceName: string,
	poem: Poem,
): Promise<void> {
	const outFile = path.join(OUT_DIR, voiceName, `${poem.slug}.mp3`);

	if (!force && (await fs.pathExists(outFile))) {
		console.log(`  skip   ${voiceName}/${poem.slug}`);
		return;
	}

	const res = await fetch(
		`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=${apiKey}`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				contents: [{ parts: [{ text: poem.text }], role: "user" }],
				generationConfig: {
					responseModalities: ["AUDIO"],
					speechConfig: {
						voiceConfig: {
							prebuiltVoiceConfig: { voiceName },
						},
					},
				},
			}),
		},
	);

	if (!res.ok) {
		const errBody = await res.text().catch(() => "");
		throw new Error(
			`Gemini TTS API error ${res.status} ${res.statusText}: ${errBody}`,
		);
	}

	const json = (await res.json()) as {
		candidates: Array<{
			content: { parts: Array<{ inlineData: { data: string } }> };
		}>;
	};
	const data = json.candidates[0]?.content?.parts[0]?.inlineData?.data;
	if (!data) throw new Error("No audio in Gemini TTS response");

	const wavBuf = Buffer.from(data, "base64");
	const mp3Buf = await convertWavToMp3(wavBuf);
	await fs.ensureDir(path.dirname(outFile));
	await fs.writeFile(outFile, mp3Buf);
	console.log(
		`  done   ${voiceName}/${poem.slug}  (${(mp3Buf.length / 1024).toFixed(0)} KB)`,
	);
}

async function runWithConcurrency<T>(
	tasks: (() => Promise<T>)[],
	limit: number,
	onError: (e: Error, idx: number) => void,
): Promise<void> {
	let errors = 0;
	let active = 0;
	let idx = 0;

	await new Promise<void>((resolve) => {
		function dispatch(): void {
			while (active < limit && idx < tasks.length) {
				const taskIdx = idx++;
				const task = tasks[taskIdx];
				if (!task) continue;
				active++;
				task()
					.catch((e) => {
						onError(e as Error, taskIdx);
						errors++;
					})
					.finally(() => {
						active--;
						if (idx < tasks.length) {
							dispatch();
						} else if (active === 0) {
							resolve();
						}
					});
			}
		}
		dispatch();
		if (tasks.length === 0) resolve();
	});

	return errors > 0
		? Promise.reject(new Error(`${errors} task(s) failed`))
		: Promise.resolve();
}

async function main() {
	const poems = await loadPoems();
	const openaiKey = await getOpenAiKey();

	const openaiTasks = OPENAI_VOICES.flatMap((voice) =>
		poems.map((poem) => () => generateOpenAiOne(openaiKey, voice, poem)),
	);

	const openaiTotal = openaiTasks.length;
	console.log(
		`[OpenAI] Voices: ${OPENAI_VOICES.length}  |  Poems: ${poems.length}  |  Total: ${openaiTotal} files  |  Concurrency: ${concurrency}`,
	);
	if (force) console.log("  (--force: regenerating all files)");
	console.log("");

	let openaiErrors = 0;
	await runWithConcurrency(openaiTasks, concurrency, (e, i) => {
		const voice = OPENAI_VOICES[Math.floor(i / poems.length)];
		const poem = poems[i % poems.length];
		console.error(`  ERROR  ${voice}/${poem?.slug}: ${e.message}`);
		openaiErrors++;
	}).catch(() => {});

	// ── ElevenLabs ──────────────────────────────────────────────────────────────

	let elevenLabsErrors = 0;
	let elevenLabsKey: string | null = null;

	if (!skipElevenLabs) {
		elevenLabsKey = await getElevenLabsKey();
		if (!elevenLabsKey) {
			console.log(
				"\n[ElevenLabs] No API key found — skipping. Set ELEVENLABS_API_KEY or use --skip-elevenlabs.\n",
			);
		}
	} else {
		console.log("\n[ElevenLabs] Skipped (--skip-elevenlabs).\n");
	}

	if (elevenLabsKey) {
		const elKey = elevenLabsKey;
		const elTasks = ELEVENLABS_VOICES.flatMap(({ id, name }) =>
			poems.map((poem) => () => generateElevenLabsOne(elKey, id, name, poem)),
		);

		console.log(
			`\n[ElevenLabs] Voices: ${ELEVENLABS_VOICES.length}  |  Poems: ${poems.length}  |  Total: ${elTasks.length} files  |  Concurrency: ${concurrency}`,
		);
		console.log("");

		await runWithConcurrency(elTasks, concurrency, (e, i) => {
			const voice = ELEVENLABS_VOICES[Math.floor(i / poems.length)];
			const poem = poems[i % poems.length];
			console.error(`  ERROR  ${voice?.name}/${poem?.slug}: ${e.message}`);
			elevenLabsErrors++;
		}).catch(() => {});
	}

	// ── Gemini ──────────────────────────────────────────────────────────────────

	let geminiErrors = 0;
	let geminiKey: string | null = null;

	if (!skipGemini) {
		geminiKey = await getGeminiKey();
		if (!geminiKey) {
			console.log(
				"\n[Gemini] No API key found — skipping. Set GEMINI_API_KEY or GOOGLE_API_KEY, or use --skip-gemini.\n",
			);
		}
	} else {
		console.log("\n[Gemini] Skipped (--skip-gemini).\n");
	}

	if (geminiKey) {
		const gKey = geminiKey;
		const gTasks = GEMINI_VOICES.flatMap(({ name }) =>
			poems.map((poem) => () => generateGeminiOne(gKey, name, poem)),
		);

		console.log(
			`\n[Gemini] Voices: ${GEMINI_VOICES.length}  |  Poems: ${poems.length}  |  Total: ${gTasks.length} files  |  Concurrency: ${concurrency}`,
		);
		console.log("");

		await runWithConcurrency(gTasks, concurrency, (e, i) => {
			const voice = GEMINI_VOICES[Math.floor(i / poems.length)];
			const poem = poems[i % poems.length];
			console.error(`  ERROR  ${voice?.name}/${poem?.slug}: ${e.message}`);
			geminiErrors++;
		}).catch(() => {});
	}

	// ── Manifest ────────────────────────────────────────────────────────────────

	// Load existing manifest to preserve entries for providers we skipped.
	let existingManifest: Record<string, string[]> = {};
	try {
		existingManifest = (await fs.readJson(
			path.join(OUT_DIR, "manifest.json"),
		)) as Record<string, string[]>;
	} catch {
		// No existing manifest — that's fine
	}

	const manifest: Record<string, string[]> = {};
	const poemSlugs = poems.map((p) => p.slug);

	for (const voice of OPENAI_VOICES) manifest[voice] = poemSlugs;

	if (elevenLabsKey) {
		for (const { id } of ELEVENLABS_VOICES) manifest[id] = poemSlugs;
	} else {
		for (const { id } of ELEVENLABS_VOICES) {
			if (existingManifest[id]) manifest[id] = existingManifest[id];
		}
	}

	if (geminiKey) {
		for (const { name } of GEMINI_VOICES) manifest[name] = poemSlugs;
	} else {
		for (const { name } of GEMINI_VOICES) {
			if (existingManifest[name]) manifest[name] = existingManifest[name];
		}
	}

	await fs.writeJson(path.join(OUT_DIR, "manifest.json"), manifest, {
		spaces: 2,
	});
	console.log(`\nWrote manifest.json`);

	// Poem text, keyed by slug — used at runtime to synthesise live previews for
	// providers that aren't pre-rendered into static mp3 files.
	const poemTexts: Record<string, string> = {};
	for (const poem of poems) poemTexts[poem.slug] = poem.text;
	await fs.writeJson(path.join(OUT_DIR, "poems.json"), poemTexts, {
		spaces: 2,
	});
	console.log(`Wrote poems.json`);

	const totalErrors = openaiErrors + elevenLabsErrors + geminiErrors;
	if (totalErrors > 0) {
		console.error(`\nDone with ${totalErrors} error(s).`);
		process.exit(1);
	} else {
		console.log("Done.");
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
