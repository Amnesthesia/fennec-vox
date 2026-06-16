import type { Chapter } from "../types";

const CHAPTER_HEADING_RE = [
	/^chapter\s+(\d+|[ivxlcdm]+)\b/i,
	/^(part|book|section|unit)\s+(\d+|[ivxlcdm]+)\b/i,
	/^\d{1,2}\.\s+[A-Z][a-z]/,
	/^[IVX]+\.\s+[A-Z]/,
];

function looksLikeHeading(line: string): boolean {
	const t = line.trim();
	return (
		t.length > 0 &&
		t.length < 120 &&
		CHAPTER_HEADING_RE.some((re) => re.test(t))
	);
}

export function cleanPdfText(raw: string): string {
	return raw
		.replace(/\f/g, "\n\n")
		.replace(/\r\n?/g, "\n")
		.replace(/[ \t]+/g, " ")
		.replace(/\n{4,}/g, "\n\n\n")
		.trim();
}

export function splitPdfIntoChapters(
	text: string,
	fallbackTitle: string,
): Chapter[] {
	const lines = text.split("\n");
	const segments: Array<{ title: string; lines: string[] }> = [];
	let current: { title: string; lines: string[] } = {
		title: fallbackTitle,
		lines: [],
	};

	for (const line of lines) {
		if (looksLikeHeading(line)) {
			if (current.lines.join("").trim().length >= 200) segments.push(current);
			current = { title: line.trim(), lines: [] };
		} else {
			current.lines.push(line);
		}
	}
	if (current.lines.join("").trim().length >= 200) segments.push(current);

	if (segments.length > 0) {
		return segments.map((seg, i) => ({
			index: i,
			spineIndex: i,
			id: `pdf-chapter-${i}`,
			title: seg.title,
			text: seg.lines
				.join("\n")
				.replace(/\n{3,}/g, "\n\n")
				.trim(),
		}));
	}

	const PSEUDO_CHUNK = 8_000;
	const words = text.split(/\s+/);
	const pseudoChapters: Chapter[] = [];
	let buf = "";
	let idx = 0;

	for (const word of words) {
		buf += (buf ? " " : "") + word;
		if (buf.length >= PSEUDO_CHUNK) {
			pseudoChapters.push({
				index: idx,
				spineIndex: idx,
				id: `pdf-section-${idx}`,
				title: `Section ${idx + 1}`,
				text: buf.trim(),
			});
			idx++;
			buf = "";
		}
	}
	if (buf.trim()) {
		pseudoChapters.push({
			index: idx,
			spineIndex: idx,
			id: `pdf-section-${idx}`,
			title: `Section ${idx + 1}`,
			text: buf.trim(),
		});
	}

	return pseudoChapters;
}
