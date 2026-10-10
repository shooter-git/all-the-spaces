import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The integration files run side by side, each with its own app and database (making one
    // and dropping it is slow on a busy machine): room enough that load alone doesn't fail them.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
