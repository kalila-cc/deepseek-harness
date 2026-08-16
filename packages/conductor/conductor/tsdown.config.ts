import { defineConfig } from 'tsdown'

// Keep the published root and invariant as independent single-entry bundles.
// A shared multi-entry build emits a hash-named fold chunk outside this
// package's publication whitelist, which breaks a deployed Bundle at import.
export default defineConfig([
  {
    entry: { index: 'lib/types/index.js' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
  {
    entry: { invariant: 'lib/types/invariant.js' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
])
