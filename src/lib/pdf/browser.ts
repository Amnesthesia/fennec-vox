import * as pdfjsLib from 'pdfjs-dist';
import { cleanPdfText, splitPdfIntoChapters } from './utils';
import type { Chapter, BookMetadata } from '../types';

// Configure the PDF.js worker for Vite's URL asset handling.
// The assignment is skipped in Node test environments where import.meta.url
// points to a file:// URL and a DOM worker cannot be created.
if (typeof window !== 'undefined') {
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.min.mjs',
    import.meta.url,
  ).href;
}

export async function extractChaptersPdf(
  file: File | ArrayBuffer,
): Promise<{ chapters: Chapter[]; metadata: BookMetadata }> {
  const arrayBuffer = file instanceof ArrayBuffer ? file : await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer) }).promise;

  const meta = await pdf.getMetadata().catch(() => null);
  const info = meta?.info as Record<string, unknown> | undefined;
  const rawName = file instanceof File ? file.name.replace(/\.pdf$/i, '') : 'document';
  const title  = (info?.['Title']  as string | undefined)?.trim() || rawName;
  const author = (info?.['Author'] as string | undefined)?.trim() || 'Unknown Author';

  const pageTexts: string[] = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const pageText = content.items
      .map((item) => ('str' in item ? item.str : ''))
      .join(' ');
    pageTexts.push(pageText);
  }

  const rawText = pageTexts.join('\n');
  const text    = cleanPdfText(rawText);
  const chapters: Chapter[] = splitPdfIntoChapters(text, title);

  return { chapters, metadata: { title, author } };
}
