import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts'],
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
    },
    environmentMatchGlobs: [
      ['src/lib/__tests__/credentials/browser.test.ts', 'jsdom'],
    ],
  },
});
