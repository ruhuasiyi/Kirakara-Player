# 🎤 Kirakara Player

基于浏览器的卡拉 OK 歌词播放器与视频导出工具。

![预览](images/preview.png)

## ✨ 功能特性

- **逐字走字动画** — 支持 LRC 时间轴驱动的逐字染色效果
- **视频背景** — 支持 MP4 视频作为背景
- **静态背景图** — 支持上传图片作为背景，可调节透明度
- **高度可定制** — 字体、字号、颜色、描边、淡入淡出、指示灯等全部可调
- **实时预览** — 1280×720 预览窗口，所见即所得
- **导出视频** — 支持 VP8 / VP9 / H.264 编码，最高 4K 60fps
- **项目管理** — 支持导入以导出.krl歌词项目或模板

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
│   └── preview.png
├── tools/
│   ├── convert-roles.html  # 旧版角色标签转换（独立页面）
│   ├── DualRuby.html       # 双注音编辑（独立页面）
│   └── nvenc-render/       # NVENC 硬件加速渲染
│       ├── server.js       # 本地服务：静态托管 + 渲染 API（pnpm start）
│       ├── render.js       # 命令行渲染（pnpm render）
│       └── render-page.html
└── README.md
```

> `js/` 通过 `<script>` 标签按固定顺序加载，没有模块系统；新增脚本时不要打乱 `index.html` 顶部的顺序。

## 🎨 可配置项

| 分类 | 配置项 |
|------|--------|
| **字体排版** | 字体名、主字大小/粗细/间距、注音大小/粗细/间距/上推 |
| **颜色描边** | 走字前/后颜色、描边前/后颜色、描边粗细 |
| **淡入淡出** | 启用/关闭、仅段落首尾、持续时长 |
| **指示灯** | 启用/关闭、持续时间、大小、颜色、描边、位置偏移 |
| **布局** | 歌词行 1/2 的 X/Y 坐标 |
| **背景** | 背景色、背景图片启用、图片透明度 |
| **标题** | 标题分组、样式、大小、位置 |

所有配置自动保存到 `localStorage`，刷新不丢失。

## 📦 外部依赖

| 库 | 加载方式 | 用途 |
|----|---------|------|
| React 18 | unpkg CDN | UI 框架 |
| ReactDOM 18 | unpkg CDN | DOM 渲染 |
| Tailwind CSS | CDN | 原子化样式 |
| Babel Standalone | unpkg CDN | 浏览器端 JSX 转译 |
| mp4box 0.5.2 | unpkg CDN | MP4 解封装与 avcC 提取 |

> 所有依赖均通过 CDN 加载，无需 `npm install` 或构建工具。

## 🌐 浏览器兼容性

| 特性 | Chrome | Edge | Firefox | Safari |
|------|--------|------|---------|--------|
| 预览播放 | 94+ ✅ | 94+ ✅ | ✅ | ✅ |
| 导出功能 | 94+ ✅ | 94+ ✅ | 不支持AAC编码导出⚠️ | 16.4+ ⚠️ |

> Firefox 不支持编码 AAC 音频，故无法导出 MP4 视频。
## ⚠️ 已知限制

- 后台标签页导出时编码器可能受 Chrome 节流影响而变慢
- H.264 编码在部分平台可能不可用
- 音频导出可能在部分浏览器不可用

## Todo
- [x] 自动角色解析功能
- [x] 导出视频为mp4格式且含有音轨
- [x] 双注音功能
- ~~[ ] 阴影等装饰性功能~~

## 📄 License

本项目遵循MIT协议。

