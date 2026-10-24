import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/cli.ts', 'src/index.ts'],
  format: ['cjs'],
  dts: true, // 自动生成 .d.ts
  clean: true,
  splitting: false,
  minify: 'terser', // 使用terser进行更高级的压缩
  minifyIdentifiers: true,
  minifySyntax: true,
  minifyWhitespace: true,
  treeshake: true,
  // The shebang must end with LF: a CR here makes Linux/macOS kernels hand `node\r`
  // to `env`, so `npx sync-upstream` dies with "env: 'node\r': No such file or directory".
  // `dist/index.js` also carries it; Node's module loader strips a leading `#!` line on
  // require, so the library entry is unaffected.
  banner: { js: '#!/usr/bin/env node\n' },
})
