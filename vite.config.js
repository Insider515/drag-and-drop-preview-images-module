import { defineConfig, transformWithEsbuild } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Browsers the stylesheet is compiled for.
 *
 * The floor is container queries and `:has()`, which the layout uses. Vite's
 * default CSS target is older than both, and naming the target says out loud
 * what the stylesheet actually needs rather than leaving it to a minifier.
 */
const CSS_TARGET = ['chrome105', 'safari16', 'firefox110', 'edge105'];

/**
 * Squeeze the newlines out of the ES bundle.
 *
 * Vite minifies identifiers in library mode but leaves the ES output laid out
 * over its lines, which is fine for a consumer whose own bundler will minify
 * it again and wasteful for one that loads `dist/drop-preview.js` straight
 * from a `<script type="module">`. Measured: 70.7 KB over 1674 lines against
 * 47.6 KB on eleven for the same code as UMD — six kilobytes of gzip for
 * whitespace nobody reads.
 *
 * It uses the esbuild Vite already carries, so nothing is added to build with.
 */
function minifyEsOutput() {
  return {
    name: 'minify-es-output',
    async generateBundle(output, bundle) {
      if (output.format !== 'es') return;
      for (const [file, chunk] of Object.entries(bundle)) {
        if (chunk.type !== 'chunk') continue;
        const minified = await transformWithEsbuild(chunk.code, file, {
          minify: true,
          format: 'esm',
          // The stylesheet has its own target; this one is about syntax the
          // browsers named there can read.
          target: 'es2022',
        });
        chunk.code = minified.code;
      }
    },
  };
}

/**
 * Two builds from one config, selected by Vite's own --mode flag:
 *
 *   vite build                library  -> dist/drop-preview.{js,umd.cjs} + css
 *   vite build --mode demo    demo page -> demo-dist/
 *
 * The library build externalises nothing — the widget has no runtime
 * dependencies, so the bundle is self-contained by construction.
 */
export default defineConfig(({ mode }) => {
  const isDemo = mode === 'demo';

  return {
    root: isDemo ? path.join(here, 'demo') : here,
    plugins: isDemo ? [] : [minifyEsOutput()],
    build: isDemo
      ? {
          outDir: path.join(here, 'demo-dist'),
          emptyOutDir: true,
          sourcemap: true,
          cssTarget: CSS_TARGET,
        }
      : {
          outDir: path.join(here, 'dist'),
          emptyOutDir: true,
          sourcemap: false,
          cssTarget: CSS_TARGET,
          lib: {
            entry: path.join(here, 'src/index.js'),
            name: 'DropPreview',
            formats: ['es', 'umd'],
            fileName: (format) =>
              format === 'es' ? 'drop-preview.js' : 'drop-preview.umd.cjs',
          },
          rollupOptions: {
            output: {
              // A fixed name keeps the `./style.css` export path stable across
              // builds, so consumers' imports never break.
              assetFileNames: 'drop-preview.[ext]',
              // The entry exports both named bindings and a default; without
              // this the UMD global would hide them behind `.default`.
              exports: 'named',
            },
          },
        },
  };
});
