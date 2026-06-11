import EPub from 'epub2';
import { htmlToPlainText } from '../text';
import type { Chapter, BookMetadata } from '../types';

function openEpub(epubPath: string): Promise<EPub> {
  return new Promise((resolve, reject) => {
    const book = new EPub(epubPath);
    book.on('end', () => resolve(book));
    book.on('error', reject);
    book.parse();
  });
}

function getChapterHtml(book: EPub, id: string): Promise<string> {
  return new Promise((resolve, reject) => {
    book.getChapter(id, (error, text) => {
      if (error) reject(new Error(`Failed to read chapter "${id}": ${String(error)}`));
      else resolve(text ?? '');
    });
  });
}

export async function extractChapters(
  epubPath: string,
): Promise<{ chapters: Chapter[]; metadata: BookMetadata }> {
  const book = await openEpub(epubPath);
  const title  = book.metadata.title   ?? 'Unknown Title';
  const author = book.metadata.creator ?? 'Unknown Author';

  const chapters: Chapter[] = [];
  for (let spineIdx = 0; spineIdx < book.flow.length; spineIdx++) {
    const item = book.flow[spineIdx]!;
    const itemId = item.id ?? '';
    let html: string;
    try {
      html = await getChapterHtml(book, itemId);
    } catch {
      continue;
    }
    const text = htmlToPlainText(html);
    if (text.length < 100) continue;
    const chapterTitle = item.title ?? `Chapter ${chapters.length + 1}`;
    chapters.push({ index: chapters.length, spineIndex: spineIdx, id: itemId, title: chapterTitle, text });
  }

  return { chapters, metadata: { title, author } };
}
