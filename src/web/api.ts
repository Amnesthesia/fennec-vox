import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { getCredentials, saveCredentials } from '../lib/credentials/browser';
import { extractChapters as extractEpubBrowser } from '../lib/epub/browser';
import { extractChaptersPdf as extractPdfBrowser } from '../lib/pdf/browser';
import { detectMarkupProvider, estimateCosts } from '../lib/markup';
import { runConversion } from '../lib/conversion';
import type { ConversionIO } from '../lib/conversion';
import type { Chapter, ChapterRecord, TtsFormat, ProgressEvent } from '../lib/types';
import type { ConversionOptions, TtsVoice, TtsModel } from '@shared/ipc';

// ── Internal state ────────────────────────────────────────────────────────────

let pendingFile: File | null = null;
let stopRequested = false;

type ProgressCb   = (e: ProgressEvent) => void;
type LogCb        = (line: string) => void;
type CompleteCb   = (e: ProgressEvent & { type: 'complete' }) => void;
type ErrorCb      = (msg: string) => void;

const progressListeners: Set<ProgressCb>  = new Set();
const logListeners:      Set<LogCb>       = new Set();
const completeListeners: Set<CompleteCb>  = new Set();
const errorListeners:    Set<ErrorCb>     = new Set();

function emitProgress(e: ProgressEvent) { progressListeners.forEach(cb => cb(e)); }
function emitLog(msg: string)           { logListeners.forEach(cb => cb(msg)); }
function emitComplete(e: ProgressEvent & { type: 'complete' }) {
  completeListeners.forEach(cb => cb(e));
}
function emitError(msg: string) { errorListeners.forEach(cb => cb(msg)); }

// ── Browser ConversionIO (in-memory, no caching) ──────────────────────────────

function createBrowserIO(): ConversionIO {
  const audioStore = new Map<string, Buffer>();

  return {
    async getMarkupCache(_key) { return null; },
    async setMarkupCache(_key, _value) {},
    audioChunkCache: null,
    chunkKey(chapterIdx, chunkIdx, fmt) {
      return `chapter-${chapterIdx}-chunk-${chunkIdx}.${fmt}`;
    },
    async saveChapterAudio(chapterIdx, data, fmt) {
      const key = `chapter-${chapterIdx}.${fmt}`;
      audioStore.set(key, data);
      return key;
    },
    async readChapterAudio(key) {
      const buf = audioStore.get(key);
      if (!buf) throw new Error(`Audio chunk not found in memory: ${key}`);
      return buf;
    },
    onProgress(event) {
      emitProgress(event);
      if (event.type === 'complete') emitComplete(event);
    },
    onLog(msg) { emitLog(msg); },
    isCancelled() { return stopRequested; },
  };
}

// ── Public API (mirrors ElectronAPI shape) ────────────────────────────────────

export const browserApi = {
  selectEpub(): Promise<string | null> {
    return new Promise(resolve => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.epub,.pdf';
      input.onchange = () => {
        const file = input.files?.[0];
        if (file) { pendingFile = file; resolve(file.name); }
        else resolve(null);
      };
      input.click();
    });
  },

  selectOutputDir(): Promise<string | null> {
    return Promise.resolve('browser-download');
  },

  getCredentials,

  saveCredentials(c: { anthropicKey: string; openaiKey: string }): Promise<void> {
    return saveCredentials(c);
  },

  openExternal(url: string): Promise<void> {
    window.open(url, '_blank', 'noopener,noreferrer');
    return Promise.resolve();
  },

  async previewVoice(opts: { voice: TtsVoice; model: TtsModel; instructions?: string }): Promise<{ audio?: string; error?: string }> {
    const { openaiKey } = await getCredentials();
    if (!openaiKey) return { error: 'No OpenAI key configured.' };
    try {
      const body: Record<string, unknown> = {
        model: opts.model,
        input: `Hey there, I'm ${opts.voice}. I'll be your narrator for this audiobook.`,
        voice: opts.voice,
      };
      if (opts.instructions) body['instructions'] = opts.instructions;
      const res = await fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${openaiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) return { error: `TTS preview failed: ${res.statusText}` };
      const arrayBuffer = await res.arrayBuffer();
      const base64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)));
      return { audio: base64 };
    } catch (e: unknown) {
      return { error: String(e) };
    }
  },

  async startConversion(opts: ConversionOptions): Promise<{ ok?: boolean; error?: string }> {
    if (!pendingFile && !opts.epubPath) return { error: 'No file selected.' };

    stopRequested = false;

    const { anthropicKey, openaiKey } = await getCredentials();
    if (!openaiKey) return { error: 'OpenAI API key is required. Configure it in Settings.' };

    let provider: ReturnType<typeof detectMarkupProvider>;
    try {
      provider = detectMarkupProvider(anthropicKey || undefined, openaiKey);
    } catch (e) {
      return { error: (e as Error).message };
    }

    // Run async — return immediately so the UI can subscribe to events first
    void (async () => {
      try {
        const file = pendingFile;

        let chapters: Awaited<ReturnType<typeof extractEpubBrowser>>['chapters'];
        let metadata: Awaited<ReturnType<typeof extractEpubBrowser>>['metadata'];

        if (file) {
          const lower = file.name.toLowerCase();
          if (lower.endsWith('.epub')) {
            ({ chapters, metadata } = await extractEpubBrowser(file));
          } else if (lower.endsWith('.pdf')) {
            ({ chapters, metadata } = await extractPdfBrowser(file));
          } else {
            emitError('Unsupported file type. Use EPUB or PDF.');
            return;
          }
        } else {
          emitError('No file available. Please select a file first.');
          return;
        }

        const completedChapters: Record<number, ChapterRecord> = {};
        const estimate = estimateCosts(completedChapters as never, {}, opts.chunkSize, opts.ttsModel, provider);
        void estimate;

        emitProgress({ type: 'start', provider, total: chapters.length, concurrency: opts.concurrency, completed: [] });
        emitLog(`Book: "${metadata.title}" by ${metadata.author}`);
        emitLog(`Chapters: ${chapters.length}  |  Markup: ${provider}`);

        const anthropic = anthropicKey ? new Anthropic({ apiKey: anthropicKey, dangerouslyAllowBrowser: true }) : null;
        const openai    = new OpenAI({ apiKey: openaiKey, dangerouslyAllowBrowser: true });
        const io: ConversionIO = createBrowserIO();

        const { assembled, chapterCount, total } = await runConversion({
          chapters, completedChapters,
          provider, anthropic, openai,
          voice: opts.voice, format: opts.format as TtsFormat,
          ttsModel: opts.ttsModel, chunkSize: opts.chunkSize,
          concurrency: opts.concurrency, ttsInstructions: opts.ttsInstructions,
          io,
          onChapterComplete: async (_ch: Chapter, _rec: ChapterRecord) => {},
        });

        if (stopRequested) { emitLog('Conversion stopped.'); return; }

        // Download the result
        const ext         = opts.format;
        const mimeTypes: Record<string, string> = { mp3: 'audio/mpeg', opus: 'audio/ogg', aac: 'audio/aac', flac: 'audio/flac' };
        const mime        = mimeTypes[ext] ?? 'audio/mpeg';
        const blob        = new Blob([new Uint8Array(assembled)], { type: mime });
        const url         = URL.createObjectURL(blob);
        const a           = document.createElement('a');
        const baseName    = (pendingFile?.name ?? 'audiobook').replace(/\.[^.]+$/, '');
        a.href            = url;
        a.download        = `${baseName}.${ext}`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 60_000);

        const totalMB = assembled.length / 1024 / 1024;
        emitLog(`\nDone! ${chapterCount}/${total} chapters — ${totalMB.toFixed(2)} MB`);
        emitProgress({ type: 'complete', outputFile: a.download, totalMB, chapters: chapterCount, total });
      } catch (e: unknown) {
        if (!stopRequested) {
          const msg = (e as Error).message ?? String(e);
          emitLog(`[ERROR] ${msg}`);
          emitError(msg);
          emitProgress({ type: 'error', message: msg });
        }
      }
    })();

    return { ok: true };
  },

  stopConversion(): Promise<{ ok?: boolean; error?: string }> {
    stopRequested = true;
    return Promise.resolve({ ok: true });
  },

  onProgress(cb: ProgressCb): () => void {
    progressListeners.add(cb);
    return () => progressListeners.delete(cb);
  },
  onLog(cb: LogCb): () => void {
    logListeners.add(cb);
    return () => logListeners.delete(cb);
  },
  onComplete(cb: CompleteCb): () => void {
    completeListeners.add(cb);
    return () => completeListeners.delete(cb);
  },
  onError(cb: ErrorCb): () => void {
    errorListeners.add(cb);
    return () => errorListeners.delete(cb);
  },

  // Browser-only: register a dropped File so startConversion can use it
  registerDroppedFile(file: File): string {
    pendingFile = file;
    return file.name;
  },
};

export type BrowserAPI = typeof browserApi;
