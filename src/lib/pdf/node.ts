import pdfParse from 'pdf-parse';
import fs from 'fs-extra';
import path from 'path';
import { cleanPdfText, splitPdfIntoChapters } from './utils';
import type { Chapter, BookMetadata } from '../types';

export async function extractChaptersPdf(
  pdfPath: string,
): Promise<{ chapters: Chapter[]; metadata: BookMetadata }> {
  const dataBuffer = await fs.readFile(pdfPath);
  const data = await pdfParse(dataBuffer);

  const title  = (data.info?.['Title']  as string | undefined)?.trim() || path.basename(pdfPath, '.pdf');
  const author = (data.info?.['Author'] as string | undefined)?.trim() || 'Unknown Author';

  const text     = cleanPdfText(data.text);
  const chapters = splitPdfIntoChapters(text, title);

  return { chapters, metadata: { title, author } };
}

export async function extractContent(
  inputPath: string,
): Promise<{ chapters: Chapter[]; metadata: BookMetadata }> {
  const ext = path.extname(inputPath).toLowerCase();
  if (ext === '.pdf')  return extractChaptersPdf(inputPath);
  // Import dynamically so this file stays require-able in Node.js-only contexts
  const { extractChapters } = await import('../epub/node');
  if (ext === '.epub') return extractChapters(inputPath);
  throw new Error(`Unsupported file format "${ext}". Only .epub and .pdf are supported.`);
}
