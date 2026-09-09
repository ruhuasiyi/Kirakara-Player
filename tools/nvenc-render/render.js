#!/usr/bin/env node
// ==================== 无头 Chromium 渲染 + FFmpeg NVENC 编码 ====================
// 复用现有 js/canvas-renderer.js（像素级与浏览器导出一致），把逐帧渲染交给
// 无头 Chromium，编码交给 FFmpeg NVENC（hevc_nvenc / h264_nvenc / av1_nvenc）。
//
// 用法示例：
//   node render.js \
//     --krl   "/path/to/xxx.krl" \
//     --audio "/path/to/xxx.flac" \
//     --bg    "/path/to/cover.jpg" \
//     --out   "/path/to/out.mp4"
//
// 可选：--fps 30 --width 1280 --height 720 --font "Sarasa Gothic J"
//       --codec hevc_nvenc --start 0 --duration 30（仅渲染片段验证）

const puppeteer = require('puppeteer-core');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const CHROMIUM = process.env.CHROMIUM || '/usr/bin/chromium';

function parseArgs() {
  const a = process.argv.slice(2);
  const get = (name, def) => {
    const i = a.indexOf(name);
    return (i >= 0 && a[i + 1] != null) ? a[i + 1] : def;
  };
  return {
    krl: get('--krl'),
    audio: get('--audio'),
    bg: get('--bg', null),
    out: get('--out', path.join(process.cwd(), 'out.mp4')),
    fps: Number(get('--fps', 30)),
    width: Number(get('--width', 1280)),
    height: Number(get('--height', 720)),
    font: get('--font', null),          // null = 用 project.krl 里的字体
    bgColor: get('--bgColor', null),    // null = 用 project.krl 里的背景色
    bgImageOpacity: Number(get('--bgImageOpacity', 1)),  // 有 --bg 时默认不透明覆盖
    codec: get('--codec', 'hevc_nvenc'),   // hevc_nvenc | h264_nvenc | av1_nvenc
    start: Number(get('--start', 0)),
    duration: get('--duration', null) ? Number(get('--duration', null)) : null, // 秒
    preset: get('--preset', 'p5'),
    cq: Number(get('--cq', 20)),
    imageFormat: get('--image-format', 'jpeg'),   // jpeg（快）| png（无损）
    keepFrames: a.includes('--keep-frames'),
  };
}

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'krkr-frames-'));
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'warning', ...args], { stdio: ['ignore', 'inherit', 'inherit'] });
    p.on('close', code => (code === 0 ? resolve() : reject(new Error('ffmpeg 退出码 ' + code))));
    p.on('error', reject);
  });
}

// 解析 .krl 工程文件：提取 `config {…}` 块（网页导出的完整配置），剩余为歌词。
// 与 index.html 的 importKrl 解析逻辑一致（括号深度匹配 + 尾随逗号容错）。
function parseKrl(text) {
  const head = text.match(/^config\s*\{/m);
  if (!head) return { config: null, lrcRaw: text.trim() };  // 纯歌词 .krl（如 SUG 导出）
  const start = head.index + head[0].length - 1;  // 指向 '{'
  let depth = 1, end = start + 1;
  while (depth > 0 && end < text.length) {
    if (text[end] === '{') depth++;
    else if (text[end] === '}') depth--;
    end++;
  }
  if (depth !== 0) return { config: null, lrcRaw: text.trim() };
  const raw = text.slice(start, end);
  const json = raw.replace(/,(\s*[}\]])/g, '$1');
  let config = null;
  try { config = JSON.parse(json); } catch (e) { console.warn('[krl] config JSON 解析失败:', e.message); }
  return { config, lrcRaw: text.slice(end).trim() };
}

async function main() {
  const opt = parseArgs();
  for (const k of ['krl', 'audio']) {
    if (!opt[k]) { console.error(`缺少参数 --${k}`); process.exit(1); }
  }
  if (!fs.existsSync(CHROMIUM)) { console.error(`找不到 chromium: ${CHROMIUM}（可用环境变量 CHROMIUM 指定）`); process.exit(1); }

  const krlText = fs.readFileSync(opt.krl, 'utf8');
  const { config: krlConfig, lrcRaw } = parseKrl(krlText);
  if (krlConfig) console.log(`[render] 已从 project.krl 加载配置（fontFamily=${krlConfig.fontFamily} colorAfter=${krlConfig.colorAfter} bgColor=${krlConfig.bgColor}）`);

  // 音频时长决定默认渲染时长（未指定 --duration 时）
  let audioDuration = null;
  try {
    const out = require('child_process').execSync(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 ${JSON.stringify(opt.audio)}`,
      { encoding: 'utf8' }
    );
    audioDuration = parseFloat(out.trim());
  } catch (e) { /* 忽略，用 --duration */ }

  const renderStart = opt.start;
  const renderEnd = opt.duration ? renderStart + opt.duration : audioDuration || 60;
  const renderDur = renderEnd - renderStart;
  const totalFrames = Math.max(1, Math.ceil(renderDur * opt.fps));
  const frameExt = opt.imageFormat === 'png' ? 'png' : 'jpg';
  console.log(`[render] 渲染区间 ${renderStart}s → ${renderEnd}s（${renderDur}s，${totalFrames} 帧 @${opt.fps}fps）`);

  // 背景图 data URL
  let bgImageDataUrl = null;
  if (opt.bg && fs.existsSync(opt.bg)) {
    const ext = path.extname(opt.bg).slice(1).toLowerCase();
    const mime = ext === 'png' ? 'image/png' : 'image/jpeg';
    bgImageDataUrl = `data:${mime};base64,${fs.readFileSync(opt.bg).toString('base64')}`;
    console.log(`[render] 背景图: ${opt.bg}`);
  }

  // ---- 启动无头 Chromium ----
  console.log(`[render] 启动 chromium: ${CHROMIUM}`);
  const browser = await puppeteer.launch({
    executablePath: CHROMIUM,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--font-render-hinting=none',
      '--force-color-profile=srgb',
      '--hide-scrollbars',
    ],
    defaultViewport: { width: opt.width, height: opt.height, deviceScaleFactor: 1 },
  });

  const framesDir = mkTmpDir();
  const t0 = Date.now();
  try {
    const page = await browser.newPage();
    const pagePath = path.join(__dirname, 'render-page.html');
    await page.goto('file://' + pagePath, { waitUntil: 'load' });

    // 以 project.krl 的配置为准，命令行参数仅作显式覆盖
    const config = { ...(krlConfig || {}) };
    if (opt.font) config.fontFamily = opt.font;
    if (opt.bgColor) config.bgColor = opt.bgColor;

    const initInfo = await page.evaluate(({ lrcRaw, config, w, h, bgImageDataUrl, bgImageOpacity, imageFormat }) => {
      return window.__init({ lrcRaw, config, w, h, bgImageDataUrl, bgImageOpacity, imageFormat });
    }, { lrcRaw, config, w: opt.width, h: opt.height, bgImageDataUrl, bgImageOpacity: opt.bgImageOpacity, imageFormat: opt.imageFormat });
    console.log(`[render] 解析歌词 ${initInfo.lyricCount} 行，双注音=${initInfo.hasDualRuby}`);

    // 等背景就绪（纯色立即，封面图等加载+合成）
    await page.waitForFunction('window.__ready()', { timeout: 10000 }).catch(() => {});

    // ---- 逐帧渲染 ----
    for (let i = 0; i < totalFrames; i++) {
      const t = renderStart + i / opt.fps;
      const dataUrl = await page.evaluate((time) => window.__renderFrame(time), t);
      const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
      fs.writeFileSync(path.join(framesDir, `${String(i).padStart(6, '0')}.${frameExt}`), Buffer.from(b64, 'base64'));
      if ((i + 1) % (opt.fps * 5) === 0 || i === totalFrames - 1) {
        const el = (Date.now() - t0) / 1000;
        const fpsNow = (i + 1) / el;
        console.log(`[render] ${i + 1}/${totalFrames} 帧  渲染速度 ${fpsNow.toFixed(1)} fps  剩~${((totalFrames - i - 1) / fpsNow).toFixed(0)}s`);
      }
    }
    await browser.close();
    console.log(`[render] 渲染完成，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    // ---- FFmpeg NVENC 编码 + 音轨 ----
    console.log(`[encode] FFmpeg ${opt.codec} ...`);
    const audioIn = ['-ss', String(renderStart)];
    if (opt.duration) audioIn.push('-t', String(opt.duration));
    const ffArgs = [
      '-y',
      '-framerate', String(opt.fps),
      '-i', path.join(framesDir, `%06d.${frameExt}`),
      ...audioIn, '-i', opt.audio,
      '-map', '0:v:0', '-map', '1:a:0',
      '-c:v', opt.codec,
      '-preset', opt.preset,
      '-cq', String(opt.cq),
      '-b:v', '0',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '192k',
      '-shortest',
      '-movflags', '+faststart',
      opt.out,
    ];
    await runFfmpeg(ffArgs);
    console.log(`[done] 输出: ${opt.out}`);
  } finally {
    if (browser.isConnected()) { try { await browser.close(); } catch (_) {} }
    if (!opt.keepFrames) { try { fs.rmSync(framesDir, { recursive: true, force: true }); } catch (_) {} }
    else console.log(`[render] 帧序列保留在: ${framesDir}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
