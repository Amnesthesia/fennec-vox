import { describe, it, expect } from 'vitest';
import { htmlToPlainText, splitIntoChunks, safeFilename, padded, sleep } from '../text';

describe('htmlToPlainText', () => {
  it('strips tags and normalises whitespace', () => {
    const html = '<p>Hello <b>world</b></p><p>Second paragraph.</p>';
    const result = htmlToPlainText(html);
    expect(result).toContain('Hello world');
    expect(result).toContain('Second paragraph.');
  });

  it('removes script and style blocks', () => {
    const html = '<p>Visible</p><script>evil()</script><style>.x{}</style>';
    const result = htmlToPlainText(html);
    expect(result).not.toContain('evil');
    expect(result).not.toContain('.x');
    expect(result).toContain('Visible');
  });

  it('converts list items with line breaks', () => {
    const html = '<ul><li>A</li><li>B</li></ul>';
    const result = htmlToPlainText(html);
    expect(result).toContain('A');
    expect(result).toContain('B');
  });

  it('collapses multiple blank lines', () => {
    const html = '<p>One</p>\n\n\n\n<p>Two</p>';
    const result = htmlToPlainText(html);
    expect(result.split('\n').filter(l => l.trim() === '').length).toBeLessThan(3);
  });
});

describe('splitIntoChunks', () => {
  it('returns the original text as a single chunk if within limit', () => {
    expect(splitIntoChunks('hello', 100)).toEqual(['hello']);
  });

  it('splits on paragraph boundaries', () => {
    const text = 'First paragraph.\n\nSecond paragraph.\n\nThird paragraph.';
    const chunks = splitIntoChunks(text, 30);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join(' ')).toContain('First paragraph.');
    expect(chunks.join(' ')).toContain('Second paragraph.');
  });

  it('splits long paragraphs by sentence', () => {
    const text = 'First sentence. Second sentence. Third sentence. Fourth sentence. Fifth sentence.';
    const chunks = splitIntoChunks(text, 30);
    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach(c => expect(c.length).toBeLessThanOrEqual(30));
  });

  it('handles text with no breaks by splitting by word', () => {
    const text = 'a '.repeat(100).trim();
    const chunks = splitIntoChunks(text, 50);
    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach(c => expect(c.length).toBeLessThanOrEqual(50));
  });

  it('does not produce empty chunks', () => {
    const text = 'Para 1.\n\n\n\nPara 2.\n\nPara 3.';
    const chunks = splitIntoChunks(text, 20);
    chunks.forEach(c => expect(c.trim()).not.toBe(''));
  });

  it('preserves all content across chunks', () => {
    const text = Array.from({ length: 20 }, (_, i) => `Sentence ${i + 1}.`).join(' ');
    const chunks = splitIntoChunks(text, 50);
    const rejoined = chunks.join(' ');
    for (let i = 1; i <= 20; i++) {
      expect(rejoined).toContain(`Sentence ${i}.`);
    }
  });
});

describe('safeFilename', () => {
  it('replaces non-alphanumeric chars with hyphens', () => {
    expect(safeFilename('Hello World!')).toBe('hello-world-');
  });

  it('collapses consecutive hyphens', () => {
    expect(safeFilename('Hello   World')).toBe('hello-world');
  });

  it('lowercases the result', () => {
    expect(safeFilename('ABC')).toBe('abc');
  });
});

describe('padded', () => {
  it('pads to 4 digits', () => {
    expect(padded(1)).toBe('0001');
    expect(padded(42)).toBe('0042');
    expect(padded(9999)).toBe('9999');
    expect(padded(10000)).toBe('10000');
  });
});

describe('sleep', () => {
  it('resolves after the specified delay', async () => {
    const start = Date.now();
    await sleep(50);
    expect(Date.now() - start).toBeGreaterThanOrEqual(40);
  });
});
