/**
 * lib/tf-loader.js —— 把 vendored 的 Transformers.js 以 ESM 载入，并挂到全局。
 *
 * 为什么不直接把这段 import 写在 offscreen.html 的 <script type="module"> 里：
 *   MV3 的 extension_pages CSP 是 `script-src 'self'`，**没有** 'unsafe-inline'，
 *   HTML 里的内联脚本会被直接拦掉（浏览器控制台会报
 *   "Executing inline script violates the following Content Security Policy directive"）。
 *   所以必须是一个独立文件，用 <script type="module" src> 引进来。
 *
 * 为什么挂到全局：lib/asr.js 是普通脚本（非 module），它拿不到 module 作用域里的变量，
 * 只能通过全局命名空间取。又因为 module 是 defer 执行的，asr.js 里一律惰性读取
 * window.__V2T_TF，不在加载期取。
 */
import * as TF from './transformers/transformers.min.js';

self.__V2T_TF = TF;
self.dispatchEvent(new Event('v2t-transformers-ready'));
console.log('[v2t] transformers 运行时已加载（导出 ' + Object.keys(TF).length + ' 项）');
