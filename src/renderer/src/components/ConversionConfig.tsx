import React, { useState, useRef } from 'react';
import type { TtsVoice, TtsFormat, TtsModel } from '@shared/ipc';

const ALL_VOICES: TtsVoice[] = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse'];
const MINI_TTS_ONLY: TtsVoice[] = ['ballad', 'verse'];

interface Props {
  voice:           TtsVoice;    onVoiceChange:           (v: TtsVoice)  => void;
  format:          TtsFormat;   onFormatChange:          (v: TtsFormat) => void;
  ttsModel:        TtsModel;    onTtsModelChange:        (v: TtsModel)  => void;
  chunkSize:       number;      onChunkSizeChange:       (v: number)    => void;
  concurrency:     number;      onConcurrencyChange:     (v: number)    => void;
  ttsInstructions: string;      onTtsInstructionsChange: (v: string)    => void;
}

export default function ConversionConfig({
  voice, onVoiceChange,
  format, onFormatChange,
  ttsModel, onTtsModelChange,
  chunkSize, onChunkSizeChange,
  concurrency, onConcurrencyChange,
  ttsInstructions, onTtsInstructionsChange,
}: Props) {
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const handleVoiceChange = (v: TtsVoice) => {
    onVoiceChange(v);
    if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; }
    setPreviewing(true);
    const audio = new Audio(`./previews/${v}.mp3`);
    audioRef.current = audio;
    audio.play().catch(() => {});
    audio.onended = () => setPreviewing(false);
    audio.onerror  = () => setPreviewing(false);
  };

  return (
    <>
      <div className="section">
        <div className="section-label">
          Voice
          {previewing && <span className="preview-badge">▶ playing</span>}
        </div>
        <div className="field">
          <select value={voice} onChange={e => void handleVoiceChange(e.target.value as TtsVoice)}>
            {ALL_VOICES.filter(v => ttsModel === 'gpt-4o-mini-tts' || !MINI_TTS_ONLY.includes(v)).map(v => (
              <option key={v} value={v}>{v.charAt(0).toUpperCase() + v.slice(1)}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="section">
        <button
          className="advanced-toggle"
          type="button"
          onClick={() => setShowAdvanced(v => !v)}
        >
          <span>Advanced</span>
          <span className="chevron">{showAdvanced ? '▲' : '▼'}</span>
        </button>

        {showAdvanced && (
          <>
            <div className="field" style={{ marginTop: 10 }}>
              <label>Format</label>
              <select value={format} onChange={e => onFormatChange(e.target.value as TtsFormat)}>
                {(['mp3', 'opus', 'aac', 'flac'] as TtsFormat[]).map(f => (
                  <option key={f} value={f}>{f.toUpperCase()}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>TTS Model</label>
              <select
                value={ttsModel}
                onChange={e => {
                  const m = e.target.value as TtsModel;
                  onTtsModelChange(m);
                  if (m !== 'gpt-4o-mini-tts' && MINI_TTS_ONLY.includes(voice)) {
                    onVoiceChange('alloy');
                  }
                }}
              >
                <option value="tts-1">Standard (tts-1)</option>
                <option value="tts-1-hd">High Quality (tts-1-hd)</option>
                <option value="gpt-4o-mini-tts">GPT-4o Mini TTS</option>
              </select>
            </div>
            {ttsModel === 'gpt-4o-mini-tts' && (
              <div className="field">
                <label>Narration style</label>
                <textarea
                  rows={3}
                  placeholder="Warm, measured audiobook narrator. Speak clearly with natural pacing."
                  value={ttsInstructions}
                  onChange={e => onTtsInstructionsChange(e.target.value)}
                  spellCheck={false}
                  style={{ resize: 'vertical', width: '100%' }}
                />
              </div>
            )}
            <div className="field">
              <label>Chunk size (chars)</label>
              <input
                type="number"
                value={chunkSize}
                min={500}
                max={8000}
                step={500}
                onChange={e => onChunkSizeChange(Number(e.target.value))}
              />
            </div>
            <div className="field">
              <label>Parallel chapters</label>
              <input
                type="number"
                value={concurrency}
                min={1}
                max={8}
                step={1}
                onChange={e => onConcurrencyChange(Number(e.target.value))}
              />
            </div>
          </>
        )}
      </div>
    </>
  );
}
