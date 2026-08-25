import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config';

// Separate from vite.config.ts because vitest's bundled Vite (peer dep) and this project's
// Vite major version drift apart just enough that merging `test` into vite.config.ts's own
// defineConfig call trips up `tsc --noEmit` on structurally-incompatible Plugin types --
// a type-only clash, not a real one (mergeConfig only cares about the plugins at runtime).
// This file isn't part of tsconfig's `include`, so it isn't type-checked, sidestepping it.
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: 'jsdom',
      setupFiles: ['./src/testSetup.ts'],
    },
  }),
);
