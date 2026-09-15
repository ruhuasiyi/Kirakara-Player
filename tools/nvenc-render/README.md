# nvenc-render

用 **FFmpeg NVENC 硬件编码**导出 Kirakara 歌词视频，绕开 Linux 版浏览器无 H.264/AAC 编码器、VP9 软件编码极慢的问题。

两条路径共用同一个渲染核心 `js/canvas-renderer.js`，效果与网页预览一致。

## 依赖

- Node.js 18+
- 依赖统一由**根目录** `package.json` + pnpm 管理（`pnpm install`，唯一依赖 `puppeteer-core`，不下载浏览器）
- 系统 Chromium（CLI 路径用，默认 `/usr/bin/chromium`，可用环境变量 `CHROMIUM` 覆盖）
- FFmpeg（需带 `--enable-nvenc`）

## 路径一：网页内导出（推荐）

```bash
pnpm start          # 等价于 node tools/nvenc-render/server.js
```

浏览器打开 `http://localhost:8765`，导出弹窗选「NVENC 硬件加速」。

服务同时提供静态托管和渲染 API：

1. 浏览器用 `js/canvas-renderer.js` 渲染**歌词层**（透明 PNG 带 alpha），不画背景
2. 背景交给 ffmpeg：静态图由浏览器合成一张 PNG 上传、视频**原文件直传**、纯色用 `lavfi` 生成
3. 帧流 pipe 给 ffmpeg，`overlay` 叠加背景后 NVENC 编码

导出浮层内有实时日志（ffmpeg 进度、错误、音频直通回退提示等）。

## 路径二：命令行批量渲染

```bash
pnpm render --krl project.krl --audio song.flac --bg cover.jpg --out out.mp4
pnpm render:help      # 全部参数
```

用 `puppeteer-core` 驱动系统 Chromium 逐帧渲染。`--krl` 优先传网页「导出工程」生成的 `project.krl`（含 `config {…}` 块，读出完整字体/颜色/背景配置），纯歌词 `.krl`/`.lrc` 也可用但走默认配置。

## 性能（实测 RTX 5060 Laptop，1920×1080）

| 场景 | 速度 |
|---|---|
| 视频背景 | ~61 fps |
| 图片背景 | ~70 fps（无歌词）/ ~56 fps（有歌词） |

改造前的两个瓶颈与对策：

- **`canvas.toBlob` 被 vsync 节流到约 16ms/帧**，且与分辨率几乎无关 → 用 canvas 池并行编码绕开。池大小有最优值：1080p 下 4 最优，8 会因内存竞争退化到 25.7ms。
- **浏览器逐帧 seek 视频平均 15.5ms/帧（随机 seek 48.7ms）** → 背景视频完全交给 ffmpeg 顺序读取，浏览器不碰视频。

## 音频直通

网页导出弹窗可选「音频直通」，用 `-c:a copy` 直接封装源音频，无二次损失。server 会在启动前用 ffprobe 预检源编码是否被 MP4 容器承载（aac/mp3/ac3/eac3/alac/flac），不兼容则自动回退到 AAC 并写入导出日志。

注意 FLAC 等无损格式封装进 MP4 属 ffmpeg 扩展，本地播放器可读，部分平台/硬件播放器可能不识别。
