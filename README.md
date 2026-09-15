# 🎤 Kirakara Player

浏览器端的卡拉 OK 歌词播放器与视频导出工具，可选 NVENC 硬件加速导出。

![预览](images/preview.png)

## ✨ 功能特性

- **逐字走字动画** — 基于字形墨迹边界的裁剪走字，由 LRC 时间轴驱动
- **注音与双注音** — 汉字上方注音，支持两套注音并行及逐字时序
- **分角色** — 按角色分配颜色、标签前缀/后缀与立绘图片，自动解析角色
- **歌曲标题** — 可配置的标题与信息行，支持前导背景图
- **视频背景 / 静态背景图** — 静态图带模糊暗化层，可调前景不透明度
- **高度可定制** — 字体、字号、颜色、描边、淡入淡出、指示灯等全部可调
- **实时预览** — 1280×720 预览窗口，所见即所得
- **两条导出路径** — 浏览器内导出（VP8/VP9，零安装）；或 NVENC 硬件加速导出（MP4/HEVC，支持音频直通与实时日志）
- **项目管理** — 支持导入与导出 `.krl` 歌词项目或模板

## 🚀 使用方式

### 本地运行（推荐：带 NVENC 硬件加速）

Linux 版 Chrome 没有 H.264/AAC 编码器（导不出 MP4），VP9 又是纯软件编码。附带的本机服务用 FFmpeg NVENC 硬件编码替代，导出快且能出 MP4。

```bash
pnpm install     # 首次，仅一个依赖（puppeteer-core，不下载浏览器）
pnpm start       # 启动本地服务
```

然后浏览器打开 `http://localhost:8765`，加载歌词与媒体，导出时选「NVENC 硬件加速」。

也可以不用 pnpm，直接 `node tools/nvenc-render/server.js`。

### 纯静态运行（只用浏览器自带导出）

不需要 NVENC 时，任何静态服务器都行：

```bash
python3 -m http.server 8000
# 或直接在浏览器打开 index.html
```

1. 用 **Chrome 94+** 或 **Edge 94+** 打开
2. 加载音频或视频文件
3. 粘贴或载入 `.lrc` 或 `.krl` 歌词
4. 点击播放按钮预览效果
5. 点击右下角导出按钮生成视频

### 命令行批量渲染

```bash
pnpm render --krl project.krl --audio song.flac --bg cover.jpg --out out.mp4
pnpm render:help    # 查看全部参数
```

### 部署到服务器

本项目为纯静态文件，无需构建。将整个目录上传到任意静态文件服务器即可（`node_modules/` 与 `tools/` 可不上传）：

```
# 示例：使用 nginx
server {
    listen 80;
    server_name kirakara.example.com;
    root /var/www/kirakara-player;
    index index.html;
}
```

也支持直接托管在 GitHub Pages、Vercel、Netlify 等平台。

> **注意**：浏览器自带的 H.264 导出画质可能稍差，推荐使用 VP9 编码导出视频，受浏览器限制，导出后的视频可能不含音轨。需要无损音质时用 NVENC 导出的「音频直通」选项。

## 📁 项目结构

```
Kirakara Player/
├── index.html              # 主页面（React 18 + Tailwind + Babel JSX）
├── package.json            # pnpm 入口（start / render）
├── css/
│   └── style.css           # 自定义样式
├── js/
│   ├── parser.js           # LRC + @Ruby 歌词解析器（实际使用）
│   ├── dom-renderer.js     # DOM 预览渲染器
│   ├── canvas-renderer.js  # Canvas 2D 渲染引擎（预览与导出共用）
│   ├── exporter.js         # 浏览器导出流水线（核心）
│   ├── export/
│   │   ├── audio-encoder.js
│   │   ├── container-reader.js
│   │   ├── decoder-provider.js
│   │   ├── encoder.js
│   │   ├── muxer.js
│   │   └── renderer.js
│   ├── codec.js            # 编码器配置与候选回退
│   ├── muxer.js            # WebM EBML 封装器
│   └── shared/
│       ├── config.js       # 默认配置 & localStorage 持久化
│       ├── measure.js      # 文字测量（墨迹边界）
│       ├── progress.js     # 走字进度计算
│       └── title.js        # 歌曲标题模型与时间轴
├── images/
│   ├── logo.png
│   ├── preview.png
│   └── wordmark.png
├── tools/
│   ├── convert-roles.html  # 旧版角色标签转换（独立页面）
│   ├── DualRuby.html       # 双注音编辑（独立页面）
│   └── nvenc-render/       # NVENC 硬件加速渲染
│       ├── server.js       # 本地服务：静态托管 + 渲染 API（pnpm start）
│       ├── render.js       # 命令行渲染（pnpm render）
│       └── render-page.html
├── CLAUDE.md               # 给 Claude Code 的项目说明
└── README.md
```

> `js/` 通过 `<script>` 标签按固定顺序加载，没有模块系统；新增脚本时不要打乱 `index.html` 顶部的顺序。

## 🎨 可配置项

| 分类 | 配置项 |
|------|--------|
| **字体排版** | 字体名、主字大小/粗细/字距 |
| **注音 1 / 2** | 大小、粗细、字距、上推距离、描边粗细 |
| **颜色描边** | 走字前/后颜色、描边前/后颜色、描边粗细 |
| **淡入淡出** | 启用/关闭、仅段落首尾、持续时长 |
| **指示灯** | 启用/关闭、持续时间、大小、间距、颜色、描边、位置偏移、淡出比例 |
| **布局** | 歌词行 1 的 X/Y、歌词行 2 的右边距/Y |
| **背景** | 背景色、背景图片启用、图片不透明度 |
| **角色** | 角色档案（显示名 / 颜色 / 立绘图片）、标签前缀・分隔符・后缀 |
| **标题** | 标题分组、样式、大小、位置 |
| **导出** | 分辨率、帧率、编码、音频直通（NVENC 路径） |

所有配置自动保存到 `localStorage`，刷新不丢失（角色立绘的 blob URL 与标题文本不入库）。

## 📦 外部依赖

**前端**（全部走 CDN，无构建步骤）

| 库 | 加载方式 | 用途 |
|----|---------|------|
| React 18 | unpkg CDN | UI 框架 |
| ReactDOM 18 | unpkg CDN | DOM 渲染 |
| Tailwind CSS | CDN | 原子化样式 |
| Babel Standalone | unpkg CDN | 浏览器端 JSX 转译 |
| mp4box 0.5.2 | unpkg CDN | MP4 解封装与 avcC 提取 |

**NVENC 导出工具**（`tools/nvenc-render/`，可选）

| 依赖 | 说明 |
|------|------|
| `puppeteer-core` | 唯一的 npm 依赖，根目录 `pnpm install` 安装（不下载浏览器） |
| 系统 Chromium | 命令行渲染路径使用，默认 `/usr/bin/chromium`，可用环境变量 `CHROMIUM` 覆盖 |
| FFmpeg | 需带 `--enable-nvenc`，并配有 NVIDIA 显卡 |

> 只做前端预览不需要任何安装；使用 NVENC 导出才需要 `pnpm install`。

## 🌐 浏览器兼容性

项目有两条导出路径，限制各不相同。

### 浏览器内导出（依赖 WebCodecs 编码器）

| 特性 | Chrome | Edge | Firefox | Safari |
|------|--------|------|---------|--------|
| 预览播放 | 94+ ✅ | 94+ ✅ | ✅ | ✅ |
| 导出 WebM（VP8/VP9） | 94+ ✅ | 94+ ✅ | ✅ | 16.4+ ⚠️ |
| 导出 MP4（需 H.264 + AAC） | 94+ ✅ | 94+ ✅ | ✗ 无 AAC 编码器 | 16.4+ ⚠️ |

> **Linux 版 Chrome/Chromium 不提供 H.264 与 AAC 编码器**（专利授权原因），因此在这些平台上浏览器内导出只能出 WebM。Firefox 同样没有 AAC 编码器。这正是项目提供 NVENC 导出路径的直接原因。

### NVENC 本地导出（`pnpm start`，绕开浏览器编码器）

| 依赖 | 要求 |
|------|------|
| 显卡 | NVIDIA，支持 NVENC（GTX 10 系及以上） |
| 驱动 | 版本支持 NVENC |
| FFmpeg | 编译时带 `--enable-nvenc` |
| 浏览器 | 任意现代浏览器（只负责渲染与上传，不参与编码） |

不受上表浏览器编码器限制，Linux 上同样可以导出 MP4（H.265/H.264/AV1）。

## ⚠️ 已知限制

**浏览器内导出**

- 后台标签页导出时编码器会被 Chrome 节流，明显变慢
- Linux 版 Chrome/Chromium 无 H.264/AAC 编码器，无法导出 MP4
- Firefox 无 AAC 编码器，同样无法导出 MP4

**NVENC 本地导出**

- 需手动启动本地服务（`pnpm start`），未启动时网页选 NVENC 导出会报错
- 需 NVIDIA 显卡 + 带 NVENC 的 FFmpeg
- 「音频直通」把 FLAC 等无损格式封装进 MP4 属 ffmpeg 扩展，本地播放器可读，但部分平台/硬件播放器可能不识别

## Todo

- [x] 自动角色解析功能
- [x] 导出视频为 mp4 格式且含有音轨
- [x] 双注音功能
- [x] NVENC 硬件加速导出（含音频直通、实时日志）
- ~~[ ] 阴影等装饰性功能~~

## 📄 License

本项目遵循 MIT 协议，详见 [LICENSE](LICENSE)。

