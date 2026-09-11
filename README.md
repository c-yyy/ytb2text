# 视频转文字助手 · 本地 AI

一个 Chrome MV3 插件：用 Whisper 在**浏览器本地**把视频 / 音频转成文字。
音频不出本机、不需要 API Key、**运行过程 0 调用成本**。

UI 与项目结构对标 [Bili-Mux（哔哩喵）](https://github.com/c-yyy/bili-mux) 的做法：
**无构建**（纯 JS 平铺根目录）、**页面内注入面板**、**Offscreen Document 干重活**。
入口优先插进站点自带的操作栏（YouTube 观看页等），没有可挂的地方才退回右下角悬浮按钮。

---

## 界面预览

在 YouTube 观看页，入口会**长在它自己的操作栏里**（「保存 / 下载」后面），和原生按钮同款外观，
点了就地弹出面板 —— 不再往画面上浮一颗球：

![YouTube 操作栏里的入口](screenshots/youtube-entry.png)

面板里就一个按钮：**「开始转写」**。音频是直接从播放器的流地址整条取下来的，
不需要录制、不需要权限：

![面板总览](screenshots/panel-overview.png)

> 两张图都由 `npm run smoke` / `npm run yt` 自动截取
> （前者是本地冒烟页，后者是**真实的 YouTube 观看页**）。

---

## 入口是怎么插进别人页面里的

「在站点自带的操作栏里加一个按钮」听起来简单，实际有三个坑：

**1. 不要 cloneNode 原生按钮。**
最直觉的做法是复制一个现成的按钮再改图标和文字，但那些节点里是自定义元素
（`button-view-model` 之类）。克隆出来的副本一插进文档就会被 upgrade 并重新渲染，
把我们塞进去的内容冲掉，最后得到一个空按钮。

**2. 抄 class，而不是抄几份固定样式。**
改成「运行时从原生按钮上读 class 名，用普通 DOM 拼自己的按钮」——
这样配色、尺寸、圆角、暗色主题全都自动跟随站点，站点改版也不怕（class 是当场读的）。
代价是要挑对「捐赠者」按钮，见下一条。

**3. `#top-level-buttons-computed` 在真实 DOM 里出现 3 次，其中靠前的是空占位。**
YouTube 会把同一段元数据渲染好几份（模板残留），`document.querySelector` 恰好会命中
那个空壳，于是抄不到任何 class，只能退化成兜底样式。
正确做法是**只在插入位置所在的那一行菜单里找捐赠者**，而不是全局查。

**4. 那一行会被 YouTube 自己折叠掉。**
窗口变窄时，`#flexible-item-buttons`（保存 / 下载那一组）会被收进「⋮」菜单 ——
容器还在 DOM 里，但尺寸为 0。这时候「插进去」等于没插，而如果代码只判断
*节点在不在*，就会误以为成功、顺手把右下角悬浮球也收起来，结果**一个入口都不剩**。
所以两处都以「**真的看得见**」为准（有尺寸 + 没被 `display:none` / `visibility:hidden`），
并且守住一条不变量：**任何时刻至少有一个可见入口**（原生入口，或悬浮球）。
折叠时入口会自动改挂到仍然展开的 `#top-level-buttons-computed`（赞 / 踩 / 分享那一行）。

**5. 「在 DOM 里」不等于「看得见」—— 按钮会被整条裁掉。**
这是真实踩到的一次线上 bug：检测全绿（命中站点规则 / 找到操作栏 / 已插入 DOM / 悬浮球已收起），
但用户**一个按钮都看不见**。真机量出来的原因是：

```
原生：  <yt-button-view-model display:inline-block>  ← 外层负责排队
          <button class="ytSpecButtonShapeNextHost" display:flex>  ← 块级也没关系，因为在外壳里
我们的：<button class="ytSpecButtonShapeNextHost" display:flex>   ← 裸按钮 = 块级 → 换行
```

`#flexible-item-buttons` 是 `display:block`，我们的裸按钮拿到 `display:flex` 就成了块级，
掉到第二行；而 `ytd-menu-renderer` 只有 44px 高且 `overflow: auto hidden` —— 第二行被整条裁掉。

解药是三条一起上，缺一条都可能复发：
- 外观从捐赠者的 `getComputedStyle` 抄，并且用**内联 `!important`** 钉死（压过站点样式表）；
- 显式写死 `display:inline-flex` + `flex:0 0 auto` + `vertical-align:middle`，不许换行、不许被压扁；
- 挂载后**量尺寸 + 逐级检查有没有被祖先的 overflow 裁掉**（这是判「看得见」的唯一标准）。

量不过就自动降级：先换「只留图标」的窄版本，再换下一个落点，实在都不行就把悬浮球放出来 ——
**任何时刻至少有一个可见入口**。

另外 YouTube 是 SPA，路由切换和局部重渲染都会把节点冲掉，所以挂了
`MutationObserver` + `yt-navigate-finish` 反复补挂；并且做了「自愈」：
首次注入时原生按钮可能还没渲染完（皮肤没抄到），等拿到捐赠者就重建一次换上原生外观。
容器被折叠这类变化**不产生 DOM 增删事件**，observer 等不到，所以额外有一个
兜底轮询（前 30 秒每秒一次，之后每 4 秒一次）。

这套逻辑的验证不看静态检查，直接上真页面：

```bash
npm run yt                      # 真实 YouTube 观看页，22 项断言
npm run yt -- --headed          # 有头，肉眼看
npm run yt -- --url=<别的视频>   # 换一个视频
```

测的是：注入位置在不在 `#flexible-item-buttons` 内、有没有误插到首页/侧栏、
class 抄没抄到、高度和同行原生按钮是否一致、图标是不是真的渲染出来了（0 尺寸 / stroke:none
都会被抓出来）、**有没有被祖先的 overflow 裁掉（这次 bug 的直接判据）**、
`checkVisibility` 与 `elementFromPoint` 是否都通过、悬浮球有没有收起、点击能否开合、
**节点被清空后会不会自动补挂**、**把那一行折叠掉之后入口会不会改挂到可见位置**、
**能不能抓到带音轨的媒体地址（核心链路）**，以及 popup 的「检测本页」链路是否通。

想单独复现 / 定位按钮的几何问题，用诊断脚本（只打数据，不做断言）：

```bash
node tools/yt-diag.js           # 按钮尺寸、被谁裁了、和原生按钮的命中对照
node tools/yt-audio-probe.js    # 抓播放器真实的媒体请求，看能不能整条下载并解码
node tools/yt-perf-probe.js     # 验证 performance 资源时间线能不能抓到媒体 URL
```

入口没出现时，点扩展图标 →「检测本页」，它会逐条告诉你卡在哪一步
（站点规则没命中 / 操作栏没找到 / 插了但不可见**以及为什么不可见**）。

---

## 快速开始

```bash
npm install          # 只装开发依赖（transformers / crx3）
npm run vendor       # 把运行时抽到 lib/transformers/（已提交，通常不用跑）
```

然后：

1. 打开 `chrome://extensions`，右上角打开**开发者模式**
2. 点「加载已解压的扩展程序」，选择**项目根目录**（不是 dist，本项目没有构建产物）
3. 打开任意 **YouTube 视频页** —— 「保存 / 下载」那一行会多出**「转文字」按钮**，点它开面板

面板只在 YouTube 上出现（manifest 的 `matches` 只写了 YouTube），其它页面不会有任何浮窗。

首次转录会下载一次模型权重（Base/q8 约 75MB），之后由浏览器 Cache Storage 缓存，
**完全离线可跑**。

> **改了代码之后一定要回 `chrome://extensions` 点一下「重新加载」，再刷新页面。**
> 只刷新页面不一定能让新的 content script 生效 —— 「按钮没出现」十有八九是这一步没做。
> popup 右上角显示的版本号（当前 `v0.3.0`）可以用来确认重载是否真的生效。

> 验证：`npm run check`（静态自检）+ `npm run smoke`（真机装扩展跑一遍 UI）。
> 想连模型推理一起验：`npm run smoke:full`。
> 想看 YouTube 操作栏入口：`npm run yt`（需要能访问 youtube.com）。
> 全跑一遍：`npm run verify:all`。

### 入口没出现怎么办

点扩展图标 →「**检测本页**」，它会逐条回答卡在哪一步：

```
页面：www.youtube.com
✓ 命中站点规则：youtube
✓ 找到可挂载的操作栏（flexible-item-buttons，共 2 个落点）
✓ 入口已插入 DOM
· 悬浮按钮已收起（原生入口正常）
抓取到的媒体请求：9 条，其中带音轨可用 5 条
操作栏探测：flexible=可见（共 23 个）｜topLevel=可见
→ 一切正常。
```

- **`✗ 这个站点没有配置原生入口`** → 面板只在 YouTube 上出现，打开一个 YouTube 视频页即可。
- **`✗ 没找到可挂载的操作栏`** → 页面还没渲染完，或那一组被折叠了；稍等会自动补挂。
- **`✗ 插进去了但看不见：被 ytd-menu-renderer 的 overflow 裁掉了`** →
  就是这个 bug 本身；正常版本会自动换「只留图标」的窄版本或换一个落点重试。
- **`抓取到的媒体请求 0 条`** → 播放器还没开始拉流，让视频播几秒再点「开始转写」。

---

## 和参考项目的对应关系

| | bili-mux | 本项目 |
|---|---|---|
| 构建 | 无构建，纯 JS 平铺根目录 | 同 |
| UI 载体 | 页面内注入面板 + popup | 同 |
| 重活位置 | Offscreen Document 跑 ffmpeg.wasm | Offscreen Document 跑 Whisper |
| 依赖落地 | `lib/ffmpeg/` 本地 vendored | `lib/transformers/` 本地 vendored |
| 二进制传输 | 分块 base64（消息通道不支持 ArrayBuffer） | 同（且先在页面侧解码成 16kHz PCM，体积小一个数量级） |
| 视觉 | 粗黑边 + 硬投影 + B站粉 | 同款语言，主色换靛蓝 `#4f46e5` |

---

## 项目结构

```
ytb2text/
├── manifest.json              # MV3 清单：权限、content_scripts、CSP
├── content.js                 # 页面侧：入口按钮自愈 + 面板 UI + 取流/下载/解码链路
├── content.css                # 面板样式（锁在 #v2t-root 下，带一套重置）
├── background.js              # Service Worker：消息路由 + Offscreen 生命周期 + 代下载
├── offscreen.html             # Offscreen 页（加载 vendored 运行时）
├── offscreen.js               # Offscreen：录音 / 解码 / 推理 / 分块收发
├── popup.html / .css / .js    # 扩展弹窗：说明 + 本页入口检测 + 打开面板
├── lib/
│   ├── tf-loader.js           # 以 ESM 载入 transformers 并挂到全局
│   ├── constants.js           # 模型 / 语言 / 设备 / 下载源元数据
│   ├── audio.js               # 任意音频 → 16kHz 单声道 Float32Array
│   ├── asr.js                 # Whisper 封装：设备探测、精度回退、分块、噪声过滤
│   ├── export.js              # TXT / SRT / VTT 格式化与下载
│   └── transformers/          # vendored 运行时（约 32MB，随仓库提交）
├── icons/
├── screenshots/               # 测试自动产出的界面截图（README 用）
├── tools/
│   ├── vendor.js              # 从 node_modules 抽运行时到 lib/
│   ├── selfcheck.js           # 静态自检：文件引用 / 样式类名 / 常量一致性
│   ├── cdp.js                 # 极简 CDP 客户端（下面两个脚本共用）
│   ├── smoke.js               # 离线冒烟测试（CDP 驱动本机 Chrome + 本地测试页）
│   ├── youtube-check.js       # 真实 YouTube 观看页验证「操作栏原生入口 + 取流链路」
│   ├── yt-diag.js             # 诊断：入口按钮的几何 / 被谁裁了 / 与原生按钮的命中对照
│   ├── yt-audio-probe.js      # 诊断：抓播放器真实的媒体请求，试下载 + 解码
│   ├── yt-perf-probe.js       # 诊断：performance 资源时间线能不能抓到媒体 URL
│   ├── pack.sh                # 打 .crx
│   └── zip.sh                 # 打商店 zip
└── docs/privacy.html          # 隐私政策（上架用）
```

`lib/` 下的四个脚本是**普通脚本**（不是 ESM），各自往全局 `V2T` 命名空间挂东西。
原因：同一份文件要同时被 manifest 的 `content_scripts.js`（页面侧）和
`offscreen.html` 的 `<script src>`（扩展页）加载，用不了模块系统。

---

## 音频从哪来（不录制、直接取流）

这是本次重构的核心。原来的做法是让用户去「录制标签页」——慢、别扭、还得多要一个权限。
现在的做法和 bili-mux 拿流的思路一致：**播放器为了播下去，一定会去 CDN 拉媒体分片**，
把那条地址整条下载下来，解码成 PCM 就是了。

链路一共四步，中间任何一步失败都会自动往下退，**不会给用户一个死胡同**：

1. **抓地址** —— 从页面的 `performance.getEntriesByType('resource')` 里捞
   `googlevideo.com` 的媒体请求（跨域也会留下 `name`，实测可用），
   顺手排掉 `generate_204` / `ptracking` / 统计之类的噪音。
2. **挑带音轨的那条** —— 按「想要程度」排序：
   纯音频轨（itag 251/140/250/249…）> 音视频复合流（itag 18/22/43…）>
   没标 itag 的未知流（下载前先用 Range 探一下 `Content-Type`，不是音视频就跳过）。
3. **整条下载** —— 流式读 + 进度条；页面内 `fetch` 被拦（CORS / 403）时换 Service Worker 再试
   （扩展有 host 权限，不受 CORS 限制），最多试 3 条候选。
4. **解码 → 转录** —— `decodeAudioData` 转 16kHz 单声道，分块送 Offscreen 跑 Whisper。

全都失败（比如站点换了 CDN、URL 全被拦）才会自动退到
`HTMLMediaElement.captureStream()` 的**边播边录**——注意这是**自动**的，
用户不需要点任何「录制」按钮；面板里会写明「已自动改为边播边录」。

视频自带字幕时（YouTube 大多有），面板里会多出**「直接取字幕」**——
**能取就别跑模型**，快 100 倍且 100% 准确。

> 顺带一提：`ytInitialPlayerResponse.streamingData.adaptiveFormats` 里的音频轨
> 现在通常**没有 `url` 字段，只有 `signatureCipher`**（要解签名才能用，不划算），
> 所以走「抓播放器真实请求」这条路反而更稳，也不用解签名。

---

## 踩过的坑（都是真机验证出来的）

### 1. `worker-src 'self' blob:` 会让扩展直接装不上

我最初照抄参考项目的 CSP 写法，Chrome 152 直接拒绝加载：

```
'content_security_policy.extension_pages': Insecure CSP value "blob:" in directive 'worker-src'
```

`extensions.loadUnpacked` 会把这个错直接抛出来。**当前 manifest 里已经没有 worker-src 了**。
（原仓库 `public/manifest.json` 有同样的问题，建议一并修掉。）

### 2. CSP 会拦掉 HTML 里的内联 `<script type="module">`

`extension_pages` 的 `script-src 'self'` 没有 `'unsafe-inline'`，所以
offscreen.html 里不能写内联模块脚本 —— 表现为运行时静默不加载，只有控制台报
`Executing inline script violates the following Content Security Policy directive`。
改成外部文件 `lib/tf-loader.js` 后正常。

### 3. `chrome.runtime.sendMessage` 不支持 ArrayBuffer

JSON 序列化会把 `ArrayBuffer` 变成 `{}`。所以跨进程的音频一律走**分块 base64**。
本项目更进一步：**在页面侧就用 WebAudio 解码成 16kHz 单声道 Float32Array 再传**，
传的是 PCM 而不是整个 mp4 容器，体积小一个数量级，也就不需要动辄几百 MB 的消息。

### 4. Offscreen 和 SW 会各收到一份 content 的消息

`chrome.runtime.sendMessage` 会广播给扩展的每个上下文。content 发的指令，
SW 和 offscreen 都会收到 —— 不设门槛的话同一条指令被处理两遍（分块重复累加）。
本项目的约定是：**offscreen 只认带 `_forwarded: true` 的消息**，那是 SW 补上的。

### 5. 长任务不要让 SW 吊着端口

推理要几分钟，用「请求-等响应」会让 SW 一直维持端口，容易被回收。
做法是：offscreen 收到长任务**立刻 ACK**，进度与结果走 `target:'ui'` 广播，
由 SW 转发到页面里的面板，面板按 `requestId` 过滤。SW 因此无需维护任何任务映射。

### 6. 面板 DOM 不能用 innerHTML

部分站点（Google 系）强制 Trusted Types，`innerHTML =` 会直接抛错。
面板全部用 `createElement` 拼。

### 7. 读页面变量必须注入 MAIN world

content script 跑在隔离世界，看不到页面的 `window.ytInitialPlayerResponse`
（YouTube 字幕轨道就挂在那儿）。要读它必须由 SW 用
`chrome.scripting.executeScript({ world: 'MAIN' })` 注入。

---

## 运行后端的选择逻辑

```
auto  → 有 WebGPU?  ──是──►  webgpu / fp16  ──失败──►  webgpu / fp32  ──失败──►  wasm / q8
                └─否──────────────────────────────────────────────────────────►  wasm / q8
```

WebGPU 下 base 模型通常接近实时；CPU(WASM) 下约 0.3~1 倍速，长视频建议先切 tiny。
扩展页拿不到 `SharedArrayBuffer`（没有 COOP/COEP），所以 WASM 线程数固定为 1，
代码里显式写死了 `numThreads = 1`，省掉 ORT 每次的探测与告警。

---

## 已知限制

- **只做 YouTube**：面板只在 YouTube 出现（其它页面完全无感）。要支持 B站等，
  在 `content.js` 的 `ENTRY_SITES` 里加一条 `match` + `anchors` 即可。
- **兜底的边播边录是按播放速度走的** —— 只在直连下载全失败时才会触发，
  10 分钟视频要播 10 分钟（正常路径是整条下载，几十秒就好）。
- **取消只在分块边界生效**：正在算的 30s 块会算完。
- **`<all_urls>` 权限偏大**：为了代下载媒体文件和从镜像站下模型，上架前可考虑收窄。
- 首次模型下载：Base/q8 约 75MB，Small/q8 约 250MB；WebGPU 走 fp16 会翻倍。
- **`hf-mirror.com` 是第三方镜像**，介意的话在设置里切回 HuggingFace 官方。

---

## 权限说明

| 权限 | 用途 |
|---|---|
| `offscreen` | 创建 Offscreen Document（SW 里跑不了模型） |
| `storage` | 记住设置与上次结果 |
| `scripting` | 兜底注入面板；注入 MAIN world 读页面字幕轨 |
| `activeTab` | 拿当前标签页 id |
| `unlimitedStorage` | 模型缓存（Cache Storage）体积不受限 |
| `host_permissions` | 页面内 fetch 被拦时由 SW 代下载媒体 + 从镜像站下模型权重 |

> 已经**去掉了 `tabCapture`**：不再需要用户去录制标签页，也省掉那条最吓人的权限提示。

---

## 隐私

音频与模型**全部在本机处理**，不经过任何服务器，也不上报任何使用数据。
详见 [隐私政策](docs/privacy.html)。

---

## 打包发布

```bash
bash tools/pack.sh    # 生成 release/ytb2text-<version>.crx（首次会生成 ytb2text.pem，务必备份）
bash tools/zip.sh     # 生成 release/ytb2text-<version>.zip（商店上架用）
```

`ytb2text.pem` 是私钥，已在 `.gitignore` 里 —— 丢了扩展 ID 就变，已安装的用户要重装。

---

## 可以接着做的

- 接 VAD（Silero）先切人声段、跳过静音，长音频能快 30%+
- 真正的流式：边录边转，不用等录完
- 字幕翻译 / 摘要（本地小 LLM，或做成可选的自带 API Key 通道）
- 结果面板里做「点时间轴跳到视频对应位置」
