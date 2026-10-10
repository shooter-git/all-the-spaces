import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The sample builds take under a second alone, but several seconds when the whole repo's
    // suites run side by side: room enough that load alone doesn't fail them.
    testTimeout: 30_000,
  },
});
