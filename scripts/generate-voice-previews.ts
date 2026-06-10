#!/usr/bin/env node
/**
 * Generates a short TTS preview MP3 for each voice and saves them to
 * src/renderer/public/previews/<voice>.mp3 so the app can play them
 * without making API calls on every voice selection.
 *
 * Usage:
 *   pnpm run generate-previews
 *
 * Reads the OpenAI key from the system keychain (same store the app uses).
 * Override with OPENAI_API_KEY env var if needed.
 */

import path from 'path';
import fs from 'fs-extra';
import keytar from 'keytar';

const SERVICE = 'Fennec Vox';
const VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse'] as const;
const OUT_DIR = path.resolve(__dirname, '../src/renderer/public/previews');
const MODEL = 'tts-1';

const PREVIEW_TEXT = "Hello, I'll be your narrator for this audiobook. I hope you enjoy the listen.";

async function getApiKey(): Promise<string> {
  if (process.env['OPENAI_API_KEY']) return process.env['OPENAI_API_KEY'];
  const key = await keytar.getPassword(SERVICE, 'openai-api-key');
  if (!key) throw new Error('No OpenAI API key found in keychain or OPENAI_API_KEY env var.');
  return key;
}

async function generatePreview(apiKey: string, voice: string): Promise<void> {
  const outFile = path.join(OUT_DIR, `${voice}.mp3`);
  if (await fs.pathExists(outFile)) {
    console.log(`  ✓ ${voice} (cached)`);
    return;
  }
  // Try tts-1 first; fall back to gpt-4o-mini-tts for newer voices
  const models = [MODEL, 'gpt-4o-mini-tts'];
  for (const model of models) {
    const res = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, voice, input: PREVIEW_TEXT, response_format: 'mp3' }),
    });
    if (!res.ok) {
      if (model === MODEL) continue;
      throw new Error(`API error for ${voice} (${model}): ${res.status} ${res.statusText}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    await fs.writeFile(outFile, buf);
    const note = model !== MODEL ? ` via ${model}` : '';
    console.log(`  ✓ ${voice}${note} (${(buf.length / 1024).toFixed(0)} KB)`);
    return;
  }
}

async function main() {
  await fs.ensureDir(OUT_DIR);
  const apiKey = await getApiKey();
  console.log(`Generating previews for ${VOICES.length} voices into ${OUT_DIR}\n`);
  for (const voice of VOICES) {
    await generatePreview(apiKey, voice);
  }
  console.log('\nDone.');
}

main().catch(e => { console.error(e); process.exit(1); });
