import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    globals: false,
    testTimeout: 30000,
    pool: 'forks', // Use forks for worker_threads compatibility
  },
  esbuild: {
    target: 'node18',
  },
});
