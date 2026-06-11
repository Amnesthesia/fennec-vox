import { load as cheerioLoad } from 'cheerio';

export function htmlToPlainText(html: string): string {
  const $ = cheerioLoad(html);
  $('script, style, head').remove();
  $('p, br, h1, h2, h3, h4, h5, h6, li').after('\n\n');
  return $.root()
    .text()
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function splitBySentences(text: string, maxSize: number): string[] {
  const chunks: string[] = [];
  const sentences = text.split(/(?<=[.!?])\s+/);
  let current = '';
  for (const sentence of sentences) {
    if (sentence.length > maxSize) {
      if (current.trim()) { chunks.push(current.trim()); current = ''; }
      let remaining = sentence;
      while (remaining.length > maxSize) {
        const cut = remaining.lastIndexOf(' ', maxSize);
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

  const paragraphs = text.split(/\n\s*\n+/).map(p => p.trim()).filter(Boolean);
  const chunks: string[] = [];
  let accumulator = '';

  for (const para of paragraphs) {
    if (para.length > maxSize) {
      if (accumulator) { chunks.push(accumulator); accumulator = ''; }
      chunks.push(...splitBySentences(para, maxSize));
    } else if (accumulator.length + (accumulator ? 2 : 0) + para.length > maxSize) {
      chunks.push(accumulator);
      accumulator = para;
    } else {
      accumulator = accumulator ? `${accumulator}\n\n${para}` : para;
    }
  }
  if (accumulator) chunks.push(accumulator);
  return chunks;
}

export function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }
export function safeFilename(str: string): string {
  return str.replace(/[^a-z0-9]/gi, '-').replace(/-+/g, '-').toLowerCase();
}
export function padded(n: number): string { return String(n).padStart(4, '0'); }
