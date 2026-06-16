import { load as cheerioLoad } from "cheerio";
import JSZip from "jszip";
import { htmlToPlainText } from "../text";
import type { BookMetadata, Chapter } from "../types";

export async function extractChapters(
	file: File | ArrayBuffer,
): Promise<{ chapters: Chapter[]; metadata: BookMetadata }> {
	const zip = await JSZip.loadAsync(file);

	const containerXml = await zip
		.file("META-INF/container.xml")
		?.async("string");
	if (!containerXml)
		throw new Error("Invalid EPUB: missing META-INF/container.xml");

	const containerDoc = cheerioLoad(containerXml, { xmlMode: true });
	const opfPath = containerDoc("rootfile").attr("full-path");
	if (!opfPath) throw new Error("Invalid EPUB: no rootfile in container.xml");

	const opfXml = await zip.file(opfPath)?.async("string");
	if (!opfXml) throw new Error(`Invalid EPUB: missing OPF at ${opfPath}`);

	const opfDoc = cheerioLoad(opfXml, { xmlMode: true });

	const title =
		opfDoc("dc\\:title,  dcterms\\:title").first().text().trim() ||
		"Unknown Title";
	const author =
		opfDoc("dc\\:creator, dcterms\\:creator").first().text().trim() ||
		"Unknown Author";

	const opfBase = opfPath.includes("/")
		? opfPath.slice(0, opfPath.lastIndexOf("/") + 1)
		: "";
	const manifest: Record<string, string> = {};
	opfDoc("manifest item, item").each((_, el) => {
		const id = opfDoc(el).attr("id");
		const href = opfDoc(el).attr("href");
		if (id && href) manifest[id] = opfBase + href;
	});

	const spineItems: string[] = [];
	opfDoc("spine itemref, itemref").each((_, el) => {
		const idref = opfDoc(el).attr("idref");
		if (idref) spineItems.push(idref);
	});

	const chapters: Chapter[] = [];
	for (let spineIdx = 0; spineIdx < spineItems.length; spineIdx++) {
		const idref = spineItems[spineIdx]!;
		const href = manifest[idref];
		if (!href) continue;

		// Normalise the path — EPUB hrefs can be relative to the OPF's directory
		const normalised = href.startsWith("/") ? href.slice(1) : href;
		const html = await zip.file(normalised)?.async("string");
		if (!html) continue;

		const text = htmlToPlainText(html);
		if (text.length < 100) continue;

		const doc = cheerioLoad(html);
		const chapterTitle =
			doc("h1, h2").first().text().trim() || `Chapter ${chapters.length + 1}`;
		chapters.push({
			index: chapters.length,
			spineIndex: spineIdx,
			id: idref,
			title: chapterTitle,
			text,
		});
	}

	return { chapters, metadata: { title, author } };
}
