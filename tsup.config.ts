import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  splitting: false,
  minify: false,
  // The SDK targets any runtime with a global fetch: Node 20+, Deno, Bun,
  // Cloudflare Workers, and Vercel Edge. No `node:*` module is imported
  // statically. undici is loaded at runtime on Node only.
  platform: 'neutral',
  external: ['undici'],
  target: 'es2022',
  outExtension({ format }) {
    return { js: format === 'cjs' ? '.cjs' : '.js' };
  },
});
