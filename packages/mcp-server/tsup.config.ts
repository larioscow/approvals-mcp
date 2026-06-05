import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'es2022',
  clean: true,
  dts: false,
  splitting: false,
  // Bundle the workspace packages (their exports point at .ts source); keep real
  // npm deps external so they resolve from node_modules at runtime.
  noExternal: ['@approvals-mcp/core', '@approvals-mcp/db'],
  banner: { js: '#!/usr/bin/env node' },
});
