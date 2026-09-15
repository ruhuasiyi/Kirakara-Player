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
  if (a.includes('--help') || a.includes('-h')) { printHelp(); process.exit(0); }
  const get = (name, def) => {
    const i = a.indexOf(name);
    return (i >= 0 && a[i + 1] != null) ? a[i + 1] : def;
  };
  return {
    krl: get('--krl'),
    audio: get('--audio', null),        // 可空（有 --video 时）
    video: get('--video', null),        // 视频背景（可选）
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
    jsonProgress: a.includes('--json-progress'),
    keepFrames: a.includes('--keep-frames'),
  };
}

// JSON 进度输出（--json-progress 时，stdout 输出可被 server 解析的 JSON 行）
let JSON_PROGRESS = false;
function emit(msg) {
  if (JSON_PROGRESS) console.log(JSON.stringify(msg));
}

// 帧序列较大（1080p@60fps 250s 可超 6GB），/tmp 是 tmpfs 空间有限会 EDQUOT，写到磁盘缓存目录
function framesBaseDir() {
  const d = path.join(os.homedir(), '.cache', 'kirakara-nvenc');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function printHelp() {
  console.log(`
Kirakara NVENC 离线渲染（命令行）

用法：
  pnpm render --krl <工程文件> --audio <音频> [选项]
  node render.js --krl <工程文件> --audio <音频> [选项]

必填：
  --krl <path>              歌词/工程文件。传网页「导出工程」生成的 project.krl
                            可读出完整配置（字体/颜色/背景），纯歌词 .krl 亦可
  --audio <path>            音轨（flac/wav/mp3/m4a…），缺省时需给 --video

背景：
  --bg <path>               静态背景图（模糊暗化层 + 前景居中，与网页一致）
  --video <path>            视频背景（ffmpeg 顺序读取，不做逐帧 seek）
  --bgImageOpacity <0-1>    静态背景前景层不透明度（默认 1）
  --bgColor <#rrggbb>       背景色 / 无背景图时的纯色底

输出：
  --out <path>              输出文件（默认 ./out.mp4）
  --width / --height        分辨率（默认 1280 / 720）
  --fps <n>                 帧率（默认 30）
  --codec <name>            hevc_nvenc | h264_nvenc | av1_nvenc（默认 hevc_nvenc）
  --preset <p1-p7>          NVENC 预设，越大越慢质量越好（默认 p5）
  --cq <n>                  恒定质量，越小画质越好（默认 20）
  --image-format <fmt>      中间帧格式 jpeg | png（默认 jpeg）

其它：
  --font <name>             覆盖工程里的字体
  --start <sec>             起始时间（默认 0）
  --duration <sec>          渲染时长（默认取音频全长）
  --json-progress           以 JSON 行输出进度（供 server.js 解析）
  --keep-frames             保留中间帧序列（调试用）
  -h, --help                显示本帮助
`);
}

function mkTmpDir() {
  return fs.mkdtempSync(path.join(framesBaseDir(), 'frames-'));
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

// 取媒体时长（秒），失败返回 null
function probeDuration(file) {
  if (!file) return null;
  try {
    const out = require('child_process').execSync(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 ${JSON.stringify(file)}`,
      { encoding: 'utf8' }
    );
    const d = parseFloat(out.trim());
    return Number.isFinite(d) ? d : null;
  } catch (e) { return null; }
}

async function main() {
  const opt = parseArgs();
  JSON_PROGRESS = opt.jsonProgress;
  if (!opt.krl) { console.error('缺少参数 --krl'); process.exit(1); }
  if (!opt.audio && !opt.video) { console.error('缺少 --audio 或 --video'); process.exit(1); }
  if (!fs.existsSync(CHROMIUM)) { console.error(`找不到 chromium: ${CHROMIUM}（可用环境变量 CHROMIUM 指定）`); process.exit(1); }

  const krlText = fs.readFileSync(opt.krl, 'utf8');
  const { config: krlConfig, lrcRaw } = parseKrl(krlText);
  if (krlConfig) console.log(`[render] 已从 project.krl 加载配置（fontFamily=${krlConfig.fontFamily} colorAfter=${krlConfig.colorAfter} bgColor=${krlConfig.bgColor}）`);

  // 渲染时长 = max(音频, 视频)（未指定 --duration 时）
  const audioDuration = probeDuration(opt.audio);
  const videoDuration = probeDuration(opt.video);

  const renderStart = opt.start;
  const renderEnd = opt.duration ? renderStart + opt.duration : (Math.max(audioDuration || 0, videoDuration || 0) || 60);
  const renderDur = renderEnd - renderStart;
  const totalFrames = Math.max(1, Math.ceil(renderDur * opt.fps));
  const frameExt = opt.imageFormat === 'png' ? 'png' : 'jpg';
  console.log(`[render] 渲染区间 ${renderStart}s → ${renderEnd}s（${renderDur}s，${totalFrames} 帧 @${opt.fps}fps）`);

  // 背景图 data URL（sniff 文件头判断 PNG/JPEG，不依赖扩展名）
  let bgImageDataUrl = null;
  if (opt.bg && fs.existsSync(opt.bg)) {
    const buf = fs.readFileSync(opt.bg);
    const isPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
    const mime = isPng ? 'image/png' : 'image/jpeg';
    bgImageDataUrl = `data:${mime};base64,${buf.toString('base64')}`;
    console.log(`[render] 背景图: ${opt.bg}`);
  }

  // 视频背景 file:// URL
  let videoSrc = null;
  if (opt.video && fs.existsSync(opt.video)) {
    videoSrc = 'file://' + path.resolve(opt.video);
    console.log(`[render] 视频背景: ${opt.video}`);
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
      // 视频背景是 file:// 加载，drawImage 到 canvas 后会被标记 taint 导致 toDataURL 抛 SecurityError。
      // 离线渲染场景无安全顾虑，禁用同源限制以允许导出画布。
      '--allow-file-access-from-files',
      '--disable-web-security',
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

    const initInfo = await page.evaluate(({ lrcRaw, config, w, h, bgImageDataUrl, bgImageOpacity, imageFormat, videoSrc }) => {
      return window.__init({ lrcRaw, config, w, h, bgImageDataUrl, bgImageOpacity, imageFormat, videoSrc });
    }, { lrcRaw, config, w: opt.width, h: opt.height, bgImageDataUrl, bgImageOpacity: opt.bgImageOpacity, imageFormat: opt.imageFormat, videoSrc });
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
        const eta = Math.max(0, Math.round((totalFrames - i - 1) / fpsNow));
        if (opt.jsonProgress) {
          emit({ type: 'progress', frame: i + 1, total: totalFrames, fps: Math.round(fpsNow * 10) / 10, eta });
        } else {
          console.log(`[render] ${i + 1}/${totalFrames} 帧  渲染速度 ${fpsNow.toFixed(1)} fps  剩~${eta}s`);
        }
      }
    }
    await browser.close();
    console.log(`[render] 渲染完成，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    // ---- FFmpeg NVENC 编码 + 音轨 ----
    console.log(`[encode] FFmpeg ${opt.codec} ...`);
    const ffArgs = [
      '-y',
      '-framerate', String(opt.fps),
      '-i', path.join(framesDir, `%06d.${frameExt}`),
    ];
    if (opt.audio) {
      const audioIn = ['-ss', String(renderStart)];
      if (opt.duration) audioIn.push('-t', String(opt.duration));
      ffArgs.push(...audioIn, '-i', opt.audio, '-map', '0:v:0', '-map', '1:a:0', '-c:a', 'aac', '-b:a', '192k');
    } else {
      ffArgs.push('-map', '0:v:0');
    }
    ffArgs.push(
      '-c:v', opt.codec,
      '-preset', opt.preset,
      '-cq', String(opt.cq),
      '-b:v', '0',
      '-pix_fmt', 'yuv420p',
      '-shortest',
      '-movflags', '+faststart',
      opt.out,
    );
    await runFfmpeg(ffArgs);
    emit({ type: 'done', path: opt.out });
    console.log(`[done] 输出: ${opt.out}`);
  } finally {
    if (browser.isConnected()) { try { await browser.close(); } catch (_) {} }
    if (!opt.keepFrames) { try { fs.rmSync(framesDir, { recursive: true, force: true }); } catch (_) {} }
    else console.log(`[render] 帧序列保留在: ${framesDir}`);
  }
}

main().catch(e => { emit({ type: 'error', message: e.message || String(e) }); console.error(e); process.exit(1); });
