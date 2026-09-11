/**
 * tools/vendor.js —— 把运行时依赖从 node_modules 抽到 lib/。
 *
 * 为什么需要这一步：
 *   MV3 的 extension_pages CSP 是 `script-src 'self'`，禁止加载远程脚本。
 *   而 Transformers.js / ONNX Runtime 默认会去 jsDelivr CDN 拉 wasm 与 mjs，
 *   在扩展页里会直接被 CSP 拦掉。所以必须把它们落到扩展本地目录。
 *
 * 为什么不是构建：本项目刻意不做打包（对标 bili-mux 的 lib/ffmpeg/ 做法），
 *   lib/ 下的产物是**提交进仓库**的静态资源，直接 `chrome://extensions` 加载即可。
 *   只有升级依赖时才需要跑一次 `npm install && node tools/vendor.js`。
 *
 * 用法：node tools/vendor.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NM = path.join(ROOT, 'node_modules');
// transformers.min.js 用 import.meta.url 推导 webpack publicPath，
// 所以它引用的 wasm/mjs 必须与它同目录 —— 全部塞进 lib/transformers/。
const OUT = path.join(ROOT, 'lib', 'transformers');

const TF_DIST = path.join(NM, '@huggingface', 'transformers', 'dist');
const ORT_DIST = path.join(NM, 'onnxruntime-web', 'dist');

// 逐个文件拷，不用通配符 —— 少拷一个 wasm 只会在运行时才炸，很难查。
// 这三项是 transformers.min.js 内部实际会去取的文件（见 bundle 里的 `s.p+"..."`）。
const FILES = [
  { from: path.join(TF_DIST, 'transformers.min.js'), to: 'transformers.min.js' },
  { from: path.join(ORT_DIST, 'ort.bundle.min.mjs'), to: 'ort.bundle.min.mjs' },
  { from: path.join(TF_DIST, 'ort-wasm-simd-threaded.jsep.mjs'), to: 'ort-wasm-simd-threaded.jsep.mjs' },
  { from: path.join(TF_DIST, 'ort-wasm-simd-threaded.jsep.wasm'), to: 'ort-wasm-simd-threaded.jsep.wasm' },
  // wasm（非 WebGPU）后端用的是不带 jsep 的那一对，缺了会退化成完全跑不起来
  { from: path.join(ORT_DIST, 'ort-wasm-simd-threaded.mjs'), to: 'ort-wasm-simd-threaded.mjs' },
  { from: path.join(ORT_DIST, 'ort-wasm-simd-threaded.wasm'), to: 'ort-wasm-simd-threaded.wasm' },
];

function main() {
  if (!fs.existsSync(NM)) {
    console.error('[vendor] 找不到 node_modules，先跑 `npm install`');
    process.exit(1);
  }
  fs.mkdirSync(OUT, { recursive: true });

  let total = 0;
  for (const f of FILES) {
    if (!fs.existsSync(f.from)) {
      console.error('[vendor] 缺失：' + f.from);
      process.exit(1);
    }
    const dest = path.join(OUT, f.to);
    fs.copyFileSync(f.from, dest);
    const size = fs.statSync(dest).size;
    total += size;
    console.log(`[vendor] ${f.to}  ${(size / 1048576).toFixed(2)} MB`);
  }
  console.log(`[vendor] 完成，共 ${(total / 1048576).toFixed(2)} MB -> lib/transformers/`);

  const tfPkg = require(path.join(NM, '@huggingface', 'transformers', 'package.json'));
  const ortPkg = require(path.join(NM, 'onnxruntime-web', 'package.json'));
  console.log(`[vendor] @huggingface/transformers ${tfPkg.version} / onnxruntime-web ${ortPkg.version}`);
}

main();
