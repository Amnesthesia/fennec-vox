#!/usr/bin/env node
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import fs from 'fs-extra';
import path from 'path';
import readline from 'readline';
import yargs from 'yargs/yargs';
import { hideBin } from 'yargs/helpers';

import { detectMarkupProvider, estimateCosts } from '../lib/markup';
import { runConversion } from '../lib/conversion';
import type { ConversionIO } from '../lib/conversion';
import { extractContent } from '../lib/pdf/node';
import { padded, safeFilename, sleep } from '../lib/text';
import { ttsFormat } from '../lib/types';
import type { Chapter, ChapterRecord, MarkupProvider, Progress, TtsFormat, TtsVoice, TtsModel } from '../lib/types';
import { buildM4b, resolveFfmpegBin } from '../lib/audio';

// ── Re-export types consumed by other modules ─────────────────────────────────
export type { MarkupProvider, TtsVoice, TtsFormat, TtsModel, Chapter, Progress };
export { detectMarkupProvider, estimateCosts, safeFilename, padded, sleep, ttsFormat };
export { runConversion, extractContent };
export { resolveFfmpegBin, buildM4b };

// ── Types used only by CLI/Electron progress stream ──────────────────────────
export type ProgressEvent = import('../lib/types').ProgressEvent;

export function emitProgress(event: ProgressEvent): void {
  console.log(`[PROGRESS] ${JSON.stringify(event)}`);
}

// ── CLI ───────────────────────────────────────────────────────────────────────

const argv = yargs(hideBin(process.argv))
  .scriptName('epub-to-audiobook')
  .usage('Usage: $0 <epub-file> [options]')
  .example('$0 book.epub --voice nova --output-dir ./my-audiobook', '')
  .example('$0 book.pdf --concurrency 4 --yes', 'PDF input, parallel, no prompt')
  .example('$0 book.epub --resume-from 5', 'restart from chapter 5')
  .option('voice', {
    alias: 'v', type: 'string' as const,
    default: (process.env['TTS_VOICE'] ?? 'alloy') as TtsVoice,
    choices: ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse'] as const,
    description: 'OpenAI TTS voice',
  })
  .option('format', {
    alias: 'f', type: 'string' as const,
    default: (process.env['TTS_FORMAT'] ?? 'm4b') as TtsFormat,
    choices: ['mp3', 'opus', 'aac', 'flac', 'm4b', 'm4a'] as const,
    description: 'Output audio format',
  })
  .option('tts-model', {
    type: 'string' as const,
    default: (process.env['TTS_MODEL'] ?? 'gpt-4o-mini-tts') as TtsModel,
    choices: ['tts-1', 'tts-1-hd', 'gpt-4o-mini-tts'] as const,
    description: 'OpenAI TTS model',
  })
  .option('tts-instructions', {
    type: 'string' as const,
    default: process.env['TTS_INSTRUCTIONS'],
    description: 'Narration style instructions (gpt-4o-mini-tts only)',
  })
  .option('chunk-size', {
    alias: 'c', type: 'number' as const,
    default: parseInt(process.env['CHUNK_SIZE'] ?? '2000', 10),
    description: 'Max characters per chunk sent to markup model',
  })
  .option('concurrency', {
    alias: 'p', type: 'number' as const,
    default: parseInt(process.env['CONCURRENCY'] ?? '1', 10),
    description: 'Chapters to process in parallel',
  })
  .option('output-dir', {
    alias: 'o', type: 'string' as const,
    default: process.env['OUTPUT_DIR'] ?? './audiobook-output',
    description: 'Directory for output files and progress state',
  })
  .option('resume-from', {
    alias: 'r', type: 'number' as const,
    description: 'Force-resume from this chapter index (0-based)',
  })
  .option('no-resume', {
    type: 'boolean' as const, default: false,
    description: 'Ignore saved progress and start fresh',
  })
  .option('redo-tts', {
    type: 'boolean' as const, default: false,
    description: 'Re-run TTS synthesis for all chapters (keeps narrator markup cache)',
  })
  .option('yes', {
    alias: 'y', type: 'boolean' as const, default: false,
    description: 'Skip cost-estimate confirmation prompt',
  })
  .demandCommand(1, 'Please supply an EPUB or PDF file path as the first argument.')
  .help()
  .parseSync();

// ── Logging ───────────────────────────────────────────────────────────────────

function timestamp(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}
function log(...args: unknown[]): void  { console.log(`[${timestamp()}]`, ...args); }
function logError(...args: unknown[]): void { console.error(`[${timestamp()}] ERROR:`, ...args); }

// ── Progress file ─────────────────────────────────────────────────────────────

function getProgressPath(dir: string): string { return path.join(dir, 'progress.json'); }

async function loadProgress(dir: string): Promise<Progress> {
  try { return await fs.readJson(getProgressPath(dir)) as Progress; }
  catch { return { completedChapters: {} }; }
}

async function saveProgress(dir: string, data: Progress): Promise<void> {
  await fs.writeJson(getProgressPath(dir), data, { spaces: 2 });
}

// ── Cost display ──────────────────────────────────────────────────────────────

function displayCostEstimate(est: ReturnType<typeof estimateCosts>, ttsModel: TtsModel, concurrency: number): void {
  const n   = (v: number, d = 0) => v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  const usd = (v: number) => `$${v.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 })}`;
  const W = 56, rule = '─'.repeat(W);
  const row = (label: string, value: string) => {
    const padding = W - 2 - label.length - value.length;
    return `│  ${label}${' '.repeat(Math.max(0, padding))}${value}  │`;
  };
  const providerLabel = est.provider === 'claude-haiku' ? 'Claude Haiku' : 'GPT-4o mini';
  console.log(`\n┌${rule}┐`);
  console.log(`│  Cost Estimate${' '.repeat(W - 15)}│`);
  console.log(`├${rule}┤`);
  console.log(row('Markup provider     :', providerLabel));
  console.log(row('Chapters to process :', `${n(est.pendingChapters)}  (${n(est.skippedChapters)} already done)`));
  console.log(row('Total input chars   :', n(est.totalInputChars)));
  console.log(row('Concurrency         :', `${concurrency} chapter(s) in parallel`));
  console.log(`├${rule}┤`);
  console.log(`│  ${providerLabel} (SSML markup)${' '.repeat(W - 20 - providerLabel.length)}│`);
  console.log(row('  Input tokens      :', `~${n(est.inputTokens)}`));
  console.log(row('  Output tokens     :', `~${n(est.outputTokens)}`));
  console.log(row('  Estimated cost    :', `~${usd(est.claudeCost)}`));
  console.log(`├${rule}┤`);
  console.log(`│  OpenAI TTS (${ttsModel})${' '.repeat(W - 16 - ttsModel.length)}│`);
  console.log(row('  Characters        :', `~${n(est.totalTtsChars)}`));
  console.log(row('  Estimated cost    :', `~${usd(est.ttsCost)}`));
  console.log(`├${rule}┤`);
  console.log(row('TOTAL               :', `~${usd(est.totalCost)}`));
  console.log(`└${rule}┘`);
  console.log('  Estimates use ~4 chars/token and current list pricing.');
  console.log('  Verify rates: anthropic.com/pricing  openai.com/pricing\n');
}

function askConfirmation(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => { rl.close(); resolve(answer.trim().toLowerCase()); });
  });
}

// ── Node.js ConversionIO (filesystem-backed) ──────────────────────────────────

function createCliIO(
  chaptersDir: string,
  narratorDir: string,
  format: TtsFormat,
  bookTitle: string,
  bookAuthor: string,
  outputFile: string,
): ConversionIO {
  return {
    async getMarkupCache(key) {
      const file = path.join(narratorDir, key);
      try { return await fs.readFile(file, 'utf8'); } catch { return null; }
    },
    async setMarkupCache(key, value) {
      await fs.writeFile(path.join(narratorDir, key), value, 'utf8');
    },
    audioChunkCache: {
      async get(key) { try { return await fs.readFile(key); } catch { return null; } },
      async set(key, data) { await fs.writeFile(key, data); },
    },
    chunkKey(chapterIdx, chunkIdx, fmt) {
      return path.join(chaptersDir, `chapter-${padded(chapterIdx)}-chunk-${padded(chunkIdx)}.${fmt}`);
    },
    async saveChapterAudio(chapterIdx, data, fmt) {
      const file = path.join(chaptersDir, `chapter-${padded(chapterIdx)}.${fmt}`);
      await fs.writeFile(file, data);
      return file;
    },
    async readChapterAudio(key) { return fs.readFile(key); },
    onProgress(event) { emitProgress(event); },
    onLog(msg) { log(msg); },
    isCancelled() { return false; },
    ...(format === 'm4b' || format === 'm4a' ? {
      async onAssemble(chapterKeys: string[], chapterTitles: string[]) {
        const ffmpegBin = resolveFfmpegBin();
        log(`Using ffmpeg: ${ffmpegBin}`);
        const chaps = chapterKeys.map((file, i) => ({ file, title: chapterTitles[i] ?? '' }));
        return buildM4b(chaps, outputFile, bookTitle, bookAuthor, ffmpegBin);
      },
    } : {}),
  };
}

// ── Main pipeline ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // When spawned via Electron (ELECTRON_RUN_AS_NODE or similar), the script's own
  // path can end up as an extra positional arg before the actual input file.
  const selfPath = path.resolve(process.argv[1] ?? '');
  const inputArg = argv._.find(p => path.resolve(String(p)) !== selfPath) ?? argv._[0];
  const inputPath = path.resolve(String(inputArg));

  if (!(await fs.pathExists(inputPath))) {
    logError(`File not found: ${inputPath}`);
    process.exit(1);
  }

  const inputExt = path.extname(inputPath).toLowerCase();
  if (inputExt !== '.epub' && inputExt !== '.pdf') {
    logError(`Unsupported format "${inputExt}". Only .epub and .pdf are accepted.`);
    process.exit(1);
  }

  const anthropicKey = process.env['ANTHROPIC_API_KEY'];
  const openaiKey    = process.env['OPENAI_API_KEY'];

  let provider: MarkupProvider;
  try {
    provider = detectMarkupProvider(anthropicKey, openaiKey);
  } catch (e) {
    logError((e as Error).message);
    process.exit(1);
  }

  log(`Markup provider: ${provider}`);

  const outputDir   = path.resolve(argv['output-dir']);
  const inputSlug   = safeFilename(path.basename(inputPath, inputExt));
  const workDir     = path.join('/tmp', 'fennec-vox', inputSlug);
  const chaptersDir = path.join(workDir, 'chapters');
  const narratorDir = path.join(workDir, 'narrator');

  await fs.ensureDir(outputDir);
  await fs.ensureDir(chaptersDir);
  await fs.ensureDir(narratorDir);
  log(`Working directory: ${workDir}`);

  const voice           = argv.voice              as TtsVoice;
  const format          = argv.format             as TtsFormat;
  const ttsModel        = argv['tts-model']       as TtsModel;
  const chunkSize       = argv['chunk-size'];
  const concurrency     = Math.max(1, argv.concurrency);
  const noResume        = argv['no-resume'];
  const redoTts         = argv['redo-tts'];
  const resumeFrom      = argv['resume-from']     as number | undefined;
  const ttsInstructions = argv['tts-instructions'] as string | undefined;

  const anthropic = anthropicKey ? new Anthropic({ apiKey: anthropicKey }) : null;
  const openai    = new OpenAI({ apiKey: openaiKey! });

  let progress: Progress = noResume ? { completedChapters: {} } : await loadProgress(workDir);

  if (redoTts && !noResume) {
    log('--redo-tts: clearing chapter audio and resetting progress (narrator markup cache kept)');
    const existing = await fs.readdir(chaptersDir).catch(() => [] as string[]);
    await Promise.all(existing.map(f => fs.remove(path.join(chaptersDir, f))));
    progress.completedChapters = {};
  }

  if (resumeFrom !== undefined) {
    log(`Forcing resume from chapter ${resumeFrom} — clearing later state`);
    for (const key of Object.keys(progress.completedChapters)) {
      if (parseInt(key, 10) >= resumeFrom) delete progress.completedChapters[Number(key)];
    }
  }

  const { chapters, metadata } = await extractContent(inputPath);
  progress.epubFile   = inputPath;
  progress.bookTitle  = metadata.title;
  progress.bookAuthor = metadata.author;
  progress.total      = chapters.length;
  await saveProgress(workDir, progress);

  const estimate = estimateCosts(chapters, progress.completedChapters, chunkSize, ttsModel, provider);
  displayCostEstimate(estimate, ttsModel, concurrency);
  const completedIndices = Object.keys(progress.completedChapters).map(Number);
  emitProgress({ type: 'start', provider, total: chapters.length, concurrency, completed: completedIndices });

  if (estimate.pendingChapters === 0) {
    log('All chapters already processed — skipping to assembly.');
  } else if (!argv.yes) {
    const answer = await askConfirmation('Proceed with these API calls? [y/N] ');
    if (answer !== 'y' && answer !== 'yes') {
      log('Aborted. Re-run with --yes to skip this prompt.');
      process.exit(0);
    }
  } else {
    log('--yes flag set, proceeding automatically.');
  }

  // Re-process chapters cached from a previous run with a different audio format
  const expectedExt = `.${ttsFormat(format)}`;
  for (const ch of chapters) {
    const rec = progress.completedChapters[ch.index];
    if (rec && !rec.file.endsWith(expectedExt)) {
      log(`  Chapter ${ch.index}: cached file is wrong format (${path.extname(rec.file)} → ${expectedExt}), re-processing`);
      delete progress.completedChapters[ch.index];
    }
  }

  if (concurrency > 1) {
    const pendingCount = chapters.filter(ch => !progress.completedChapters[ch.index]).length;
    log(`\nProcessing ${pendingCount} chapters with concurrency=${concurrency}…`);
  }

  const outputFile = path.join(outputDir, `${path.basename(inputPath, inputExt)}.${format}`);
  const io = createCliIO(chaptersDir, narratorDir, format, metadata.title, metadata.author, outputFile);

  const { assembled, chapterCount, total } = await runConversion({
    chapters, completedChapters: progress.completedChapters,
    provider, anthropic, openai,
    voice, format, ttsModel, chunkSize, concurrency, ttsInstructions,
    bookTitle: metadata.title, bookAuthor: metadata.author,
    io,
    onChapterComplete: async () => {
      await saveProgress(workDir, progress);
    },
  });

  // For m4b/m4a: onAssemble wrote the file directly; for other formats write it now
  if (format !== 'm4b' && format !== 'm4a') {
    await fs.writeFile(outputFile, assembled);
  }

  const stat = await fs.stat(outputFile);
  const totalMB = stat.size / 1024 / 1024;
  log(`\nDone! Audiobook written to: ${outputFile}`);
  log(`Total size: ${totalMB.toFixed(2)} MB | Chapters: ${chapterCount}/${total}`);
  emitProgress({ type: 'complete', outputFile, totalMB, chapters: chapterCount, total });
}

if (require.main === module) {
  main().catch(e => {
    logError((e as Error).stack ?? String(e));
    emitProgress({ type: 'error', message: (e as Error).message });
    process.exit(1);
  });
}
