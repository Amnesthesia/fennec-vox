#!/usr/bin/env node

/**
 * Generates a TTS preview MP3 for every voice × poem combination and saves them to
 * src/renderer/public/previews/<voice>/<poem-slug>.mp3
 *
 * Usage:
 *   pnpm run generate-previews          # skip already-cached files
 *   pnpm run generate-previews --force  # regenerate everything
 *
 * Poems are read from scripts/poems/*.txt — the filename (without .txt) is used
 * as the slug and the file content is sent to the TTS API verbatim.
 *
 * After generation a manifest.json is written to the previews directory so the
 * app knows which slugs are available for each voice without needing filesystem
 * access at runtime.
 *
 * Reads the OpenAI key from the system keychain (same store the app uses).
 * Override with OPENAI_API_KEY env var if needed.
 */

import path from "node:path";
import fs from "fs-extra";

const SERVICE = "Fennec Vox";
const MODEL = "gpt-4o-mini-tts";
const POEMS_DIR = path.resolve(__dirname, "poems");
const OUT_DIR = path.resolve(__dirname, "../src/renderer/public/previews");
const VOICES = [
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

const force = process.argv.includes("--force");
const concurrency = parseInt(
	process.argv.find((a) => a.startsWith("--concurrency="))?.split("=")[1] ??
		"8",
	10,
);

// ─────────────────────────────────────────────────────────────────────────────

async function getApiKey(): Promise<string> {
	if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
	// Lazy-load keytar so an arch mismatch only fails if we actually need the keychain
	// (i.e. when OPENAI_API_KEY is not set in the environment).
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const keytar =
		(require("keytar") as typeof import("keytar")).default ?? require("keytar");
	const key = await keytar.getPassword(SERVICE, "openai-api-key");
	if (!key)
		throw new Error(
			"No OpenAI API key found in keychain. Set OPENAI_API_KEY env var or save a key in the app first.",
		);
	return key;
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

async function generateOne(
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
			model: MODEL,
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

async function main() {
	const poems = await loadPoems();
	const apiKey = await getApiKey();

	const total = poems.length * VOICES.length;
	console.log(
		`Poems: ${poems.length}  |  Voices: ${VOICES.length}  |  Total: ${total} files  |  Concurrency: ${concurrency}`,
	);
	if (force) console.log("  (--force: regenerating all files)");
	console.log("");

	// Build flat task list: all voice × poem combinations
	const tasks = VOICES.flatMap((voice) =>
		poems.map((poem) => ({ voice, poem })),
	);

	let errors = 0;
	let active = 0;
	let idx = 0;

	await new Promise<void>((resolve, reject) => {
		void reject; // unused but satisfies linter
		function dispatch(): void {
			while (active < concurrency && idx < tasks.length) {
				const { voice, poem } = tasks[idx++]!;
				active++;
				generateOne(apiKey, voice, poem)
					.catch((e) => {
						console.error(
							`  ERROR  ${voice}/${poem.slug}: ${(e as Error).message}`,
						);
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

	const manifest: Record<string, string[]> = {};
	for (const voice of VOICES) manifest[voice] = poems.map((p) => p.slug);

	await fs.writeJson(path.join(OUT_DIR, "manifest.json"), manifest, {
		spaces: 2,
	});
	console.log(`\nWrote manifest.json`);

	// Poem text, keyed by slug — used at runtime to synthesise live previews for
	// providers (like ElevenLabs) that aren't pre-rendered into static mp3 files.
	const poemTexts: Record<string, string> = {};
	for (const poem of poems) poemTexts[poem.slug] = poem.text;
	await fs.writeJson(path.join(OUT_DIR, "poems.json"), poemTexts, {
		spaces: 2,
	});
	console.log(`Wrote poems.json`);

	if (errors > 0) {
		console.error(`\nDone with ${errors} error(s).`);
		process.exit(1);
	} else {
		console.log("Done.");
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
