import { describe, expect, it } from "vitest";
import { cleanPdfText, splitPdfIntoChapters } from "../../pdf/utils";

describe("cleanPdfText", () => {
	it("converts form-feeds to double newlines", () => {
		expect(cleanPdfText("Page1\fPage2")).toBe("Page1\n\nPage2");
	});

	it("normalises Windows line endings", () => {
		expect(cleanPdfText("line1\r\nline2")).toBe("line1\nline2");
	});

	it("collapses inline whitespace", () => {
		expect(cleanPdfText("too   many   spaces")).toBe("too many spaces");
	});

	it("caps consecutive blank lines at 3", () => {
		const input = "a\n\n\n\n\n\nb";
		const result = cleanPdfText(input);
		expect(
			result.split("\n").filter((l) => l === "").length,
		).toBeLessThanOrEqual(3);
	});
});

describe("splitPdfIntoChapters", () => {
	it("splits on chapter headings", () => {
		const text = `
Chapter 1
${"Content of chapter one. ".repeat(10)}

Chapter 2
${"Content of chapter two. ".repeat(10)}
`.trim();
		const chapters = splitPdfIntoChapters(text, "My Book");
		expect(chapters.length).toBe(2);
		expect(chapters[0]?.title).toBe("Chapter 1");
		expect(chapters[1]?.title).toBe("Chapter 2");
	});

	it("returns a single chapter with fallbackTitle when no headings found", () => {
		// The initial segment (title=fallbackTitle) accumulates all lines when
		// there are no heading matches. If it is >= 200 chars it is returned as-is.
		const text = "word ".repeat(2000).trim(); // ~10 000 chars, no chapter headings
		const chapters = splitPdfIntoChapters(text, "Fallback");
		expect(chapters.length).toBe(1);
		expect(chapters[0]?.title).toBe("Fallback");
	});

	it("skips segments shorter than 200 chars", () => {
		const text = `Chapter 1\nToo short.\n\nChapter 2\n${"Long content. ".repeat(20)}`;
		const chapters = splitPdfIntoChapters(text, "Book");
		// Chapter 1 body < 200 chars — should be absent or merged
		const hasChapter1 = chapters.some((c) => c.title === "Chapter 1");
		expect(hasChapter1).toBe(false);
		expect(chapters.some((c) => c.title === "Chapter 2")).toBe(true);
	});

	it("assigns sequential indices", () => {
		const text = `Chapter 1\n${"x".repeat(300)}\n\nChapter 2\n${"x".repeat(300)}`;
		const chapters = splitPdfIntoChapters(text, "Book");
		chapters.forEach((ch, i) => expect(ch.index).toBe(i));
	});
});
