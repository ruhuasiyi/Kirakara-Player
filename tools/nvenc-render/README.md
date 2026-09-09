# nvenc-render

脱离浏览器、用 **NVENC 硬件编码** 渲染 Kirakara 歌词视频的离线工具。

核心思路：复用主应用的 `js/canvas-renderer.js`（保证与浏览器预览/导出一致），把逐帧渲染交给**无头 Chromium**，把编码交给 **FFmpeg NVENC**（`hevc_nvenc`/`h264_nvenc`/`av1_nvenc`）。绕开了 Linux 版浏览器无法编码 H.264/HEVC、以及 VP9 软件编码极慢的问题。

## 依赖

- Node.js（`npm install` 安装 `puppeteer-core`，**不下载浏览器**）
- 系统 Chromium（默认 `/usr/bin/chromium`，可用环境变量 `CHROMIUM` 覆盖）
- FFmpeg（需带 `--enable-nvenc`）

## 用法

```bash
node render.js \
  --krl   "/path/to/project.krl" \
  --audio "/path/to/xxx.flac" \
  --bg    "/path/to/cover.jpg" \
  --out   "/path/to/out.mp4"
```

> `--krl` 优先传**网页导出的工程文件**（`project.krl`，含 `config {…}` 块），工具会读取其中的字体/颜色/背景色等完整配置，保证与网页预览一致。纯歌词 `.krl`/`.lrc` 也可用，但走默认配置。

## 参数

| 参数 | 默认 | 说明 |
|------|------|------|
| `--krl` | 必填 | 歌词/工程文件（`.krl` 含 `{漢字\|假名}` 注音与逐字时间戳；`project.krl` 另含 `config` 块） |
| `--audio` | 必填 | 音轨（flac/wav/mp3…，ffmpeg 直接编 AAC） |
| `--bg` | 无 | 背景图（cover-fit 铺满） |
| `--out` | `./out.mp4` | 输出路径 |
| `--fps` | 30 | 帧率 |
| `--width` / `--height` | 1280 / 720 | 分辨率 |
| `--font` | 项目配置 | 字体（显式传才覆盖 project.krl 的 `fontFamily`） |
| `--bgColor` | 项目配置 | 背景色（显式传才覆盖 project.krl 的 `bgColor`） |
| `--bgImageOpacity` | 1 | 封面透明度（默认不透明覆盖 `bgColor`，不会露出发绿的底） |
| `--codec` | `hevc_nvenc` | `hevc_nvenc` / `h264_nvenc` / `av1_nvenc` |
| `--preset` / `--cq` | `p5` / `20` | NVENC 质量（`p1` 最快 → `p7` 最好；`cq` 越小画质越好） |
| `--start` / `--duration` | 0 / 音频全长 | 渲染片段（验证用） |
| `--image-format` | `jpeg` | 帧中间格式；`jpeg`（快）或 `png`（无损） |
| `--keep-frames` | 关闭 | 保留帧序列用于调试 |

## 性能（实测 RTX 5060 Laptop）

- 渲染（Chromium 逐帧 + JPEG 输出）：纯色 ~96 fps，封面图 ~52 fps
- 编码（`hevc_nvenc`）：约 3.6x 实时（250s 全片约 1 分钟）
- 一条完整 250s 全片（1280×720@30fps + AAC）约 3-4 分钟

## 与浏览器方案的差异

- 渲染引擎一致（同一个 `drawLyricsOnCanvas`），歌词走字/双注音/双行效果与浏览器预览一致。
- 背景已复刻网页双层效果：模糊暗化层（cover + `blur(20px) brightness(0.4)`）+ 前景层（contain + 透明度）。
- 分角色立绘（`characterProfiles.image`）暂未接入。
