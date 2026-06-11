// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { getCredentials, saveCredentials } from '../../credentials/browser';

describe('browser credentials (localStorage)', () => {
  beforeEach(() => localStorage.clear());

  it('returns empty strings when nothing is stored', async () => {
    const creds = await getCredentials();
    expect(creds.openaiKey).toBe('');
    expect(creds.anthropicKey).toBe('');
  });

  it('saves and retrieves keys', async () => {
    await saveCredentials({ openaiKey: 'sk-abc', anthropicKey: 'sk-ant-xyz' });
    const creds = await getCredentials();
    expect(creds.openaiKey).toBe('sk-abc');
    expect(creds.anthropicKey).toBe('sk-ant-xyz');
  });

  it('updating one key leaves the other unchanged', async () => {
    await saveCredentials({ openaiKey: 'sk-original', anthropicKey: 'sk-ant-original' });
    await saveCredentials({ openaiKey: 'sk-new' });
    const creds = await getCredentials();
    expect(creds.openaiKey).toBe('sk-new');
    expect(creds.anthropicKey).toBe('sk-ant-original');
  });

  it('removes a key when empty string is saved', async () => {
    await saveCredentials({ openaiKey: 'sk-abc' });
    await saveCredentials({ openaiKey: '' });
    const creds = await getCredentials();
    expect(creds.openaiKey).toBe('');
    expect(localStorage.getItem('fennec-vox:openai-key')).toBeNull();
  });

  it('ignores undefined fields in partial saves', async () => {
    await saveCredentials({ openaiKey: 'sk-abc' });
    await saveCredentials({ anthropicKey: 'ant' });  // only update anthropic
    const creds = await getCredentials();
    expect(creds.openaiKey).toBe('sk-abc');
    expect(creds.anthropicKey).toBe('ant');
  });
});
