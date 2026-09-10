# 视频转文字助手 · 本地 AI

一个 Chrome MV3 浏览器插件：用 Whisper 在**浏览器本地**把视频 / 音频转成文字。
音频不出本机、不需要 API Key、**0 调用成本**。

---

## 快速开始

```bash
npm install
npm run build          # 产出 dist/
```

然后：

1. 打开 `chrome://extensions`，右上角打开**开发者模式**
2. 点「加载已解压的扩展程序」，选择项目里的 `dist/` 目录
3. 点工具栏插件图标 → 侧边栏打开（Chrome 116+）

首次转录会下载一次模型权重（Base/q8 约 75MB），之后由浏览器 Cache Storage 缓存，**完全离线可跑**。

> 开发时用 `npm run dev` 可以 watch 构建，改完代码回 `chrome://extensions` 点一下刷新即可。

---

## 对你那份方案的 5 处关键修正

原方案方向是对的，但有几个会直接导致「跑不起来」或「转出来是乱码」的点：

| # | 原方案 | 问题 | 本项目的做法 |
|---|--------|------|--------------|
| 1 | `Xenova/whisper-tiny.en` | **`.en` 是纯英文模型，中文会被强行音译成一堆英文字母**。中文必须用多语言版 | 默认 `Xenova/whisper-base`（多语言），语言下拉里可强制 `zh` |
| 2 | 「yt-dlp 逻辑」 | 插件里**跑不了二进制程序**。yt-dlp 是 Python/可执行文件，浏览器扩展无法调用 | 改用三条纯 Web 链路：`chrome.tabCapture` 录标签页声 / 抓页面 `<video>` 直链 / 用户选本地文件 |
| 3 | 「推理放在 Background Script」 | MV3 的 Service Worker 里**没有 WebGPU、没有 AudioContext、没有 MediaRecorder**，而且随时会被回收 | 真正的推理放在 **Offscreen Document**（完整的 Extension Page 环境），SW 只做消息转发和 `tabCapture` 授权 |
| 4 | 直接 `import` Transformers.js | MV3 的 CSP 禁止加载远程脚本，而 ONNX Runtime 默认会从 jsDelivr 拉 `.wasm` | 构建时把 `ort-*.wasm / ort-*.mjs` 拷到 `dist/ort/`，并把 `env.backends.onnx.wasm.wasmPaths` 指到本地 |
| 5 | 从 HuggingFace 下模型 | 国内直连 `huggingface.co` 经常极慢或不通 | 内置「模型下载源」选项，默认 `hf-mirror.com` 镜像（路径结构与官方一致） |

另外补了一点原方案没提的：**如果页面本身带字幕（比如 YouTube），直接取字幕比跑 ASR 快 100 倍且 100% 准确** —— 侧边栏会列出来，能取就别转录。

---

## 架构

```
┌──────────────┐   chrome.runtime    ┌──────────────────┐
│  Side Panel  │ ──────────────────► │  Service Worker  │
│  (侧边栏 UI) │                     │  消息转发 / 授权  │
└──────────────┘                     └────────┬─────────┘
       ▲                                      │ 转发
       │ progress / result                    ▼
       │                          ┌──────────────────────────┐
       └──────────────────────────┤  Offscreen Document      │
                                  │  ├─ MediaRecorder 录音   │
                                  │  ├─ WebAudio 解码→16kHz │
                                  │  └─ Transformers.js      │
                                  │      Whisper (WebGPU/WASM)│
                                  └──────────────────────────┘
```

- `src/sidepanel.*` — 侧边栏 UI（来源选择、设置、进度、结果、TXT/SRT/VTT 导出）
- `src/background.js` — Service Worker：开侧边栏、创建 Offscreen、调 `tabCapture.getMediaStreamId`
- `src/offscreen.js` — 录音 + 解码 + 推理
- `src/lib/asr.js` — Whisper 封装：设备探测、精度回退链、分块、噪声过滤
- `src/lib/audio.js` — 任意音频 → 16kHz 单声道 Float32Array（Whisper 的硬要求）
- `public/content.js` — 页面侧扫描 `<video>/<audio>` 与自带字幕轨（不参与打包）

### 运行后端的选择逻辑

```
auto  → 有 WebGPU?  ──是──►  webgpu / fp16  ──失败──►  webgpu / fp32  ──失败──►  wasm / q8
                └─否────────────────────────────────────────────────────────────►  wasm / q8
```

WebGPU 下 base 模型通常能做到接近实时；CPU(WASM) 下大约是实时速度的 0.3~1 倍，长视频建议先切 tiny 试试。

---

## 三种音频来源

| 来源 | 适用场景 | 限制 |
|------|----------|------|
| **录制当前标签页** | 任何能播的站点（YouTube / B站 / 腾讯视频 / 网课…） | 必须**实时播放**（1 倍速），最长 15 分钟自动停止；Chrome 会显示「正在共享此标签页」提示条 |
| **本地音视频文件** | 已经下载好的 mp4/mp3/wav/webm… | 最稳定，不依赖播放 |
| **页面内视频** | 页面 `<video>` 是 http(s) 直链时 | blob: / m3u8 之类的流媒体地址拿不到原始文件，此时请用「录制」 |

YouTube 等站点如果检测到自带字幕，页面内视频面板会额外列出「直接取字幕」，点了秒出、不跑模型。

---

## 已知限制

- **录制是实时的**：10 分钟视频要播 10 分钟。想快进就只能用「本地文件」或「页面直链」。
- **取消不是真中断**：目前只在分块边界生效，正在算的 30s 块会算完。
- **`dist/assets/` 下会多一份 `ort-wasm-*.wasm`（约 21MB）**，与 `dist/ort/` 内容重复。这是 Rollup 自动产出的资源副本，保留它是为了在 `wasmPaths` 未生效时仍有兜底；打包发布时可以手动删掉。
- **首次模型下载**：Base/q8 约 75MB，Small/q8 约 250MB；WebGPU 走 fp16 会翻倍。
- **`hf-mirror.com` 是第三方镜像**，介意的话在「模型下载源」里切回 HuggingFace 官方。

---

## 可以接着做的

- 接 VAD（Silero）先切人声段，跳过静音，长音频能快 30%+
- 真正的流式：边录边转，不用等录完
- 字幕翻译/摘要（本地用小 LLM，或做成可选的自带 API Key 通道）
- 打包发布到 Chrome 应用商店（需要先去掉 `<all_urls>` 收窄权限）
