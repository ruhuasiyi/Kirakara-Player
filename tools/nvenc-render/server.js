#!/usr/bin/env node
// ==================== 本地服务：serve 项目 + NVENC 渲染 API ====================
// 一站式：`node server.js` 后浏览器访问 http://localhost:8765 即为完整应用。
// 渲染由**浏览器直接完成**（复用页面里已加载的 canvas-renderer + 已解析的歌词），
// 帧流式 POST 给本服务，本服务直接 pipe 给 ffmpeg NVENC 编码。
//
// API：
//   POST /api/render/stream       → { jobId }（JSON: fps/w/h/codec/audioExt/preset/cq）
//   PUT  /api/render/:id/audio    → 音频二进制（可选）
//   POST /api/render/:id/frames   → JPEG 帧流（image2pipe 喂 ffmpeg，响应在编码完成后返回）
//   GET  /api/render/:id/status   → { state, error }
//   GET  /api/render/:id/download → 输出 mp4

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PORT = Number(process.env.PORT || 8765);
const ROOT = path.resolve(__dirname, '..', '..');   // 项目根
// 磁盘临时目录（/tmp 是 tmpfs，大分辨率高帧率的中间数据会撑爆 → 写磁盘缓存目录）
const TMP_BASE = path.join(os.homedir(), '.cache', 'kirakara-nvenc');

const jobs = new Map();  // jobId -> job

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sanitizeExt(ext) {
  if (!ext) return '';
  const clean = String(ext).replace(/[^a-zA-Z0-9.]/g, '');
  return clean.startsWith('.') ? clean : '.' + clean;
}

// 静态文件服务（serve 项目根，路径穿越防护）
function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/') rel = '/index.html';
  const filePath = path.normalize(path.join(ROOT, rel));
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

// 启动 ffmpeg NVENC 编码
// 输入 0：歌词层 PNG 帧流（带 alpha）；输入 1：背景（视频/静态图/纯色）；输入 2：音频
// 背景由 ffmpeg 提供并合成，浏览器完全不碰视频，省掉逐帧 seek 的巨额开销
function startFfmpeg(job) {
  const m = job.meta;
  const W = m.w || 1920, H = m.h || 1080, fps = m.fps || 60;
  const color = String(m.bgColor || '#000000').replace('#', '0x');
  const ffArgs = ['-y'];

  // 输入 0：歌词层帧流
  ffArgs.push('-f', 'image2pipe', '-vcodec', 'png', '-framerate', String(fps), '-i', '-');

  // 输入 1：背景
  if (job.bgFile && job.bgKind === 'video') {
    ffArgs.push('-i', job.bgFile);
  } else if (job.bgFile) {
    ffArgs.push('-loop', '1', '-framerate', String(fps), '-i', job.bgFile);
  } else {
    ffArgs.push('-f', 'lavfi', '-i', `color=c=${color}:s=${W}x${H}:r=${fps}`);
  }

  // 输入 2：音频
  let audioIdx = -1;
  if (job.audioFile) { audioIdx = 2; ffArgs.push('-ss', String(m.start || 0), '-i', job.audioFile); }

  // 背景规整（视频按 letterbox 缩放居中）→ 叠加歌词层
  const bgFilter = (job.bgKind === 'video')
    ? `[1:v]fps=${fps},scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[bg]`
    : `[1:v]scale=${W}:${H},setsar=1,fps=${fps}[bg]`;
  ffArgs.push('-filter_complex', `${bgFilter};[bg][0:v]overlay=0:0:format=auto,format=yuv420p[v]`, '-map', '[v]');
  if (audioIdx >= 0) ffArgs.push('-map', `${audioIdx}:a:0`, '-c:a', 'aac', '-b:a', '192k');

  ffArgs.push(
    '-c:v', m.codec || 'hevc_nvenc',
    '-preset', m.preset || 'p5',
    '-cq', String(m.cq != null ? m.cq : 20),
    '-b:v', '0',
    '-shortest',
    '-movflags', '+faststart',
    job.outPath,
  );
  console.log(`[job ${job.id}] 启动 ${m.codec} 编码 bg=${job.bgKind || 'color'} audio=${!!job.audioFile}`);
  const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'warning', ...ffArgs], { stdio: ['pipe', 'inherit', 'inherit'] });
  job.ff = ff;
  ff.stdin.on('error', () => {});  // 浏览器端中断时 stdin 写入失败，忽略
  return ff;
}

// POST frames：追加歌词层 PNG 数据（首次调用时启动 ffmpeg），立即响应
function handleFrames(req, res, job) {
  job.state = 'encoding';
  const ff = job.ff || startFfmpeg(job);
  let bytes = 0;
  req.on('data', chunk => { bytes += chunk.length; if (ff.stdin.writable) ff.stdin.write(chunk); });
  req.on('end', () => { console.log(`[job ${job.id}] 收到帧块 ${bytes} 字节`); json(res, 200, { ok: true }); });
}

// POST finish：结束帧流，等待 ffmpeg 编码完成
function handleFinish(req, res, job) {
  if (!job.ff) return json(res, 400, { error: 'no frames received' });
  if (job.ffClosed) return json(res, 200, { ok: job.state === 'done', error: job.err });
  job.ffClosed = true;
  job.ff.stdin.end();
  job.ff.on('close', (code) => {
    job.state = code === 0 ? 'done' : 'error';
    if (code !== 0) job.err = 'ffmpeg 退出码 ' + code;
    json(res, code === 0 ? 200 : 500, { ok: code === 0, error: job.err });
  });
}

function handleApi(req, res, urlPath) {
  const seg = urlPath.split('?')[0].split('/').filter(Boolean);  // ['api','render',...]

  // POST /api/render/stream
  if (req.method === 'POST' && seg.length === 3 && seg[1] === 'render' && seg[2] === 'stream') {
    readBody(req).then((body) => {
      let meta;
      try { meta = JSON.parse(body.toString()); } catch (e) { return json(res, 400, { error: 'bad json' }); }
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      fs.mkdirSync(TMP_BASE, { recursive: true });
      const tmpDir = fs.mkdtempSync(path.join(TMP_BASE, 'job-'));
      const job = {
        id, meta, tmpDir,
        audioFile: null,
        bgFile: null, bgKind: null,
        createdAt: Date.now(),
        state: 'uploading',
        outPath: path.join(tmpDir, 'out.mp4'),
        ff: null, ffClosed: false, err: null,
      };
      jobs.set(id, job);
      json(res, 200, { jobId: id });
    });
    return;
  }

  if (seg.length >= 4 && seg[1] === 'render') {
    const id = seg[2];
    const job = jobs.get(id);
    if (!job) return json(res, 404, { error: 'job not found' });
    const action = seg[3];

    // PUT 上传音频（可选）
    if (req.method === 'PUT' && action === 'audio') {
      const ext = sanitizeExt(job.meta.audioExt || '.bin');
      const file = path.join(job.tmpDir, 'audio' + ext);
      const ws = fs.createWriteStream(file);
      req.pipe(ws);
      ws.on('finish', () => { job.audioFile = file; json(res, 200, { ok: true }); });
      ws.on('error', () => json(res, 500, { error: 'write failed' }));
      return;
    }
    // PUT 上传背景（视频原文件 或 浏览器合成好的静态背景 PNG）
    if (req.method === 'PUT' && action === 'bg') {
      const kind = job.meta.bgKind === 'video' ? 'video' : 'image';
      const ext = kind === 'video' ? sanitizeExt(job.meta.videoExt || '.mp4') : '.png';
      const file = path.join(job.tmpDir, 'bg' + ext);
      const ws = fs.createWriteStream(file);
      req.pipe(ws);
      ws.on('finish', () => { job.bgFile = file; job.bgKind = kind; json(res, 200, { ok: true }); });
      ws.on('error', () => json(res, 500, { error: 'write failed' }));
      return;
    }
    // POST 帧流（浏览器渲染的歌词层 PNG，边收边编码）
    if (req.method === 'POST' && action === 'frames') {
      return handleFrames(req, res, job);
    }
    // POST finish：结束帧流，等待编码完成
    if (req.method === 'POST' && action === 'finish') {
      return handleFinish(req, res, job);
    }
    if (req.method === 'GET' && action === 'status') {
      return json(res, 200, { state: job.state, error: job.err });
    }
    if (req.method === 'GET' && action === 'download') {
      if (!fs.existsSync(job.outPath)) return json(res, 404, { error: 'no output yet' });
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Disposition': 'attachment; filename="out.mp4"' });
      return fs.createReadStream(job.outPath).pipe(res);
    }
    return json(res, 404, { error: 'unknown api' });
  }
  json(res, 404, { error: 'not found' });
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }
  const urlPath = req.url || '/';
  if (urlPath.startsWith('/api/')) return handleApi(req, res, urlPath);
  return serveStatic(req, res, urlPath);
});

server.listen(PORT, () => {
  console.log(`Kirakara NVENC 渲染服务已启动： http://localhost:${PORT}`);
  console.log('浏览器打开上面的地址，导出时选择「NVENC 硬件加速」，帧由浏览器直接渲染并流式发送。');
});

// 定期清理超过 1 小时的 job（保留产物便于重新下载）
setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.createdAt > 3600_000) {
      jobs.delete(id);
      try { fs.rmSync(job.tmpDir, { recursive: true, force: true }); } catch (_) {}
    }
  }
}, 600_000).unref();
