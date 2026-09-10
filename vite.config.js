import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * ONNX Runtime 的 wasm 运行时（含 WebGPU 版 jsep）必须在本地。
 * MV3 的 CSP 禁止加载远程脚本，所以从 node_modules 拷到 dist/ort/，
 * 运行时再用 chrome.runtime.getURL('ort/') 指过去。
 */
function copyOrtRuntime() {
  const sourceDirs = [
    path.join(rootDir, 'node_modules/onnxruntime-web/dist'),
    path.join(rootDir, 'node_modules/@huggingface/transformers/dist'),
  ];

  return {
    name: 'copy-ort-runtime',
    apply: 'build',
    closeBundle() {
      const dest = path.join(rootDir, 'dist', 'ort');
      fs.mkdirSync(dest, { recursive: true });
      const seen = new Set();
      let count = 0;
      for (const dir of sourceDirs) {
        if (!fs.existsSync(dir)) continue;
        for (const file of fs.readdirSync(dir)) {
          if (!/^ort-.*\.(wasm|mjs)$/.test(file)) continue;
          if (seen.has(file)) continue;
          seen.add(file);
          fs.copyFileSync(path.join(dir, file), path.join(dest, file));
          count++;
        }
      }
      console.log(`[copy-ort] copied ${count} runtime files -> dist/ort`);
    },
  };
}

/**
 * Vite 会把 src/ 下的 HTML 原样输出到 dist/src/，
 * 但 manifest 里写的是扁平路径（sidepanel.html），所以构建完统一提到 dist 根目录。
 */
function flattenHtml() {
  return {
    name: 'flatten-html',
    apply: 'build',
    closeBundle() {
      const nested = path.join(rootDir, 'dist', 'src');
      if (!fs.existsSync(nested)) return;
      const dist = path.join(rootDir, 'dist');
      for (const file of fs.readdirSync(nested)) {
        fs.renameSync(path.join(nested, file), path.join(dist, file));
      }
      fs.rmdirSync(nested);
      console.log('[flatten-html] moved html entries to dist root');
    },
  };
}

export default defineConfig({
  root: rootDir,
  publicDir: 'public',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'esnext',
    minify: false,
    rollupOptions: {
      input: {
        sidepanel: path.join(rootDir, 'src/sidepanel.html'),
        offscreen: path.join(rootDir, 'src/offscreen.html'),
        background: path.join(rootDir, 'src/background.js'),
      },
      output: {
        format: 'es',
        entryFileNames: (chunk) =>
          chunk.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash].[ext]',
      },
    },
  },
  plugins: [copyOrtRuntime(), flattenHtml()],
});
