import { load as cheerioLoad } from "cheerio";
import type { Chapter } from "./types";

export function htmlToPlainText(html: string): string {
	const $ = cheerioLoad(html);
	$("script, style, head").remove();
	$("p, br, h1, h2, h3, h4, h5, h6, li").after("\n\n");
	return $.root()
		.text()
		.replace(/[ \t]+/g, " ")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function splitBySentences(text: string, maxSize: number): string[] {
	const chunks: string[] = [];
	const sentences = text.split(/(?<=[.!?])\s+/);
	let current = "";
	for (const sentence of sentences) {
		if (sentence.length > maxSize) {
			if (current.trim()) {
				chunks.push(current.trim());
				current = "";
			}
			let remaining = sentence;
			while (remaining.length > maxSize) {
				const cut = remaining.lastIndexOf(" ", maxSize);
				const boundary = cut > 0 ? cut : maxSize;
				chunks.push(remaining.slice(0, boundary).trim());
				remaining = remaining.slice(boundary).trim();
			}
			current = remaining;
		} else if (current.length + 1 + sentence.length > maxSize) {
			chunks.push(current.trim());
			current = sentence;
		} else {
			current = current ? `${current} ${sentence}` : sentence;
		}
	}
	if (current.trim()) chunks.push(current.trim());
	return chunks;
}

export function splitIntoChunks(text: string, maxSize: number): string[] {
	if (text.length <= maxSize) return [text];

	const paragraphs = text
		.split(/\n\s*\n+/)
		.map((p) => p.trim())
		.filter(Boolean);
	const chunks: string[] = [];
	let accumulator = "";

	for (const para of paragraphs) {
		if (para.length > maxSize) {
			if (accumulator) {
				chunks.push(accumulator);
				accumulator = "";
			}
			chunks.push(...splitBySentences(para, maxSize));
		} else if (
			accumulator.length + (accumulator ? 2 : 0) + para.length >
			maxSize
		) {
			chunks.push(accumulator);
			accumulator = para;
		} else {
			accumulator = accumulator ? `${accumulator}\n\n${para}` : para;
		}
	}
	if (accumulator) chunks.push(accumulator);
	return chunks;
}

export function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}
export function safeFilename(str: string): string {
	return str
		.replace(/[^a-z0-9]/gi, "-")
		.replace(/-+/g, "-")
		.toLowerCase();
}
export function padded(n: number): string {
	return String(n).padStart(4, "0");
}

// ── Excerpt selection for narration-style suggestions ─────────────────────────

const SUMMARY_TITLE_RE = /^\s*(summary|synopsis|overview|preface|foreword)\b/i;
const MAX_EXCERPT_CHARS = 3000;
const MIN_FIRST_CHAPTER_CHARS = 200;

export interface BookExcerpt {
	excerpt: string;
	source: "summary-chapter" | "first-chapter";
}

// Picks the text most likely to reveal a book's genre and tone: a chapter
// that explicitly summarises the book (if one exists near the start), or
// else its opening chapter — skipping a suspiciously short first "chapter"
// (title/copyright page) in favour of the next one.
export function findExcerpt(chapters: Chapter[]): BookExcerpt {
	const searchLimit = Math.min(chapters.length, 5);
	for (let i = 0; i < searchLimit; i++) {
		const chapter = chapters[i];
		if (chapter && SUMMARY_TITLE_RE.test(chapter.title)) {
			return {
				excerpt: chapter.text.slice(0, MAX_EXCERPT_CHARS),
				source: "summary-chapter",
			};
		}
	}

	let idx = 0;
	if (
		chapters.length > 1 &&
		(chapters[0]?.text.trim().length ?? 0) < MIN_FIRST_CHAPTER_CHARS
	) {
		idx = 1;
	}
	return {
		excerpt: (chapters[idx]?.text ?? "").slice(0, MAX_EXCERPT_CHARS),
		source: "first-chapter",
	};
}
