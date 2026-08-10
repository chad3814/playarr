import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'server',
          environment: 'node',
          include: ['packages/server/test/**/*.test.ts', 'packages/shared/test/**/*.test.ts'],
        },
      },
    ],
  },
});
