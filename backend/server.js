const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { execFile } = require('node:child_process');
const { pipeline } = require('node:stream');
const OpenCC = require('opencc-js');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');

const app = express();
const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const PORT = Number(process.env.PORT || 3000);
const YT_DLP_PYTHON = process.env.YT_DLP_PYTHON || 'python3.11';
const YT_DLP_DENO = process.env.YT_DLP_DENO || '/home/admin/.local/bin/deno';
const YT_DLP_COOKIES_FILE = process.env.YT_DLP_COOKIES_FILE || path.join(__dirname, 'youtube_cookies.txt');
const AUDIO_DOWNLOAD_TIMEOUT_MS = Number(process.env.AUDIO_DOWNLOAD_TIMEOUT_MS || 10 * 60 * 1000);
const AUDIO_UPSTREAM_TIMEOUT_SECONDS = Number(process.env.AUDIO_UPSTREAM_TIMEOUT_SECONDS || 300);
const AUDIO_READ_BUFFER_BYTES = Number(process.env.AUDIO_READ_BUFFER_BYTES || 1024 * 1024);
const LYRIC_ALGO_VERSION = 'sync-fixed-v28-pure-cloud-ios';

// ==========================================
// 🌟 引入 AI 助手引擎
// ==========================================
let aiAgent = null;
try {
    aiAgent = require('./ai_agent');
    console.log('🤖 Aura AI 助手模块已成功挂载加载');
} catch (e) {
    console.warn('⚠️ 未找到 ai_agent.js 或加载失败，AI 功能暂时禁用:', e.message);
}

// 初始化本地缓存目录
const CACHE_DIR = process.env.AUDIO_CACHE_DIR || path.join(__dirname, 'cache');
if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
}
if (!fs.existsSync(YT_DLP_COOKIES_FILE)) {
    console.warn(`⚠️ 未配置 YouTube cookies；若出口 IP 触发登录校验，请提供: ${YT_DLP_COOKIES_FILE}`);
}

const converter = OpenCC.Converter({ from: 'tw', to: 'cn' });

const DEFAULT_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
    Accept: '*/*'
};

const lyricCache = new Map();
const LYRIC_CACHE_TTL = 24 * 60 * 60 * 1000;

// 防止并发下载同一个文件的锁机制
const downloadingMap = new Map();

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'HEAD', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Range'],
    exposedHeaders: ['Content-Length', 'Content-Range', 'Accept-Ranges', 'X-Audio-Cache']
}));

app.use(express.json({ limit: '1mb' }));

// ================== 工具函数 ==================
function toSimpleChinese(text) {
    if (!text) return '';
    try { return converter(String(text)); } catch { return String(text); }
}

function extractVideoId(url) {
    try {
        const parsed = new URL(String(url));
        const hostname = parsed.hostname.toLowerCase().replace(/^www\./, '');
        let videoId = '';
        if (hostname === 'youtu.be') videoId = parsed.pathname.split('/').filter(Boolean)[0] || '';
        if (hostname === 'youtube.com' || hostname.endsWith('.youtube.com')) {
            videoId = parsed.searchParams.get('v') || parsed.pathname.match(/^\/(?:embed|v|shorts)\/([^/]+)/)?.[1] || '';
        }
        return VIDEO_ID_PATTERN.test(videoId) ? videoId : null;
    } catch {
        return null;
    }
}

function runYtDlp(args, timeout = 60000) {
    const commonArgs = [
        '-m', 'yt_dlp',
        '--force-ipv4',
        '--no-warnings',
        '--js-runtimes', `deno:${YT_DLP_DENO}`
    ];
    if (fs.existsSync(YT_DLP_COOKIES_FILE)) {
        commonArgs.push('--cookies', YT_DLP_COOKIES_FILE);
    }
    return new Promise((resolve, reject) => {
        execFile(
            YT_DLP_PYTHON,
            [...commonArgs, ...args],
            { timeout, maxBuffer: 1024 * 1024 * 50 },
            (error, stdout, stderr) => {
                if (error) { reject(new Error(stderr || error.message)); return; }
                resolve(stdout);
            }
        );
    });
}

function sendAudioError(res, err) {
    const detail = String(err?.message || err);
    const requiresCookies = /sign in to confirm|cookies-from-browser|--cookies/i.test(detail);
    const status = requiresCookies ? 503 : 500;
    const error = requiresCookies ? 'YouTube 要求登录验证，请配置 cookies' : '音频处理失败';
    if (!res.headersSent) res.status(status).json({ error, detail });
}

function parseDurationToSeconds(v) {
    if (!v) return null;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    const parts = String(v).split(':').map(Number);
    if (parts.some(n => Number.isNaN(n))) return null;
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    return null;
}

function stripHtmlEntities(str = '') { return String(str).replace(/&/g, '&').replace(/'/g, "'").replace(/'/g, "'").replace(/"/g, '"').replace(/</g, '<').replace(/>/g, '>'); }
function removeNoise(text = '') { let s = toSimpleChinese(stripHtmlEntities(text)); s = s.replace(/【[^】]*】/g, ' ').replace(/\[[^\]]*]/g, ' ').replace(/（[^）]*）/g, ' ').replace(/\([^)]*\)/g, ' ').replace(/[《》「」『』]/g, ' ').replace(/\b(official|music|video|mv|lyrics?|lyric|audio|visualizer|live|cover|remix|version|full|hd|4k|1080p|pinyin|karaoke|instrumental|prod\.?|feat\.?|ft\.?)\b/gi, ' ').replace(/官方|歌词版|动态歌词|动态拼音歌词|拼音歌词|拼音|中字|字幕|完整版|高清|现场|现场版|纯享版|无损|伴奏|翻唱|官方版|新歌|音频/gi, ' ').replace(/[＿_｜|/\\·•●★☆♪♫♬♩~～×]/g, ' ').replace(/\s*-\s*/g, ' ').replace(/\s+/g, ' ').trim(); return s; }
function cleanArtistName(text = '') { return removeNoise(text).replace(/- Topic/gi, '').replace(/VEVO|Official|Records|Music|Studio|频道|頻道|Channel|Artist|歌手|工作室|音乐/gi, '').replace(/\s+/g, ' ').trim(); }
const ARTIST_ALIAS = [ ['周杰伦', '周杰倫', 'jaychou', 'jay chou'], ['林俊杰', '林俊傑', 'jjlin', 'jj lin'], ['邓紫棋', '鄧紫棋', 'gem', 'g.e.m', 'g e m'], ['王力宏', 'leehom', 'wang leehom'], ['陈奕迅', '陳奕迅', 'eason', 'eason chan'], ['五月天', 'mayday'], ['蔡依林', 'jolin', 'jolin tsai'], ['孙燕姿', '孫燕姿', 'stefanie sun'] ];
function applyArtistAlias(text = '') { let s = toSimpleChinese(String(text)).toLowerCase(); const compact = s.replace(/[^a-z0-9\u4e00-\u9fa5]/g, ''); for (const group of ARTIST_ALIAS) { const canonical = group[0]; for (const alias of group) { const a = String(alias).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]/g, ''); if (a && compact.includes(a)) { s += ` ${canonical}`; } } } return s; }
function normalizeForCompare(text = '') { return removeNoise(applyArtistAlias(text)).toLowerCase().replace(/pt\s*(\d+)/gi, 'part$1').replace(/part\s*(\d+)/gi, 'part$1').replace(/[^a-z0-9\u4e00-\u9fa5]/g, ''); }
function normalizeArtistForCompare(text = '') { return cleanArtistName(applyArtistAlias(text)).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]/g, ''); }

function isPrivateAddress(address) {
    if (net.isIPv4(address)) {
        const parts = address.split('.').map(Number);
        return parts[0] === 10 || parts[0] === 127 || parts[0] === 0 ||
            (parts[0] === 169 && parts[1] === 254) ||
            (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
            (parts[0] === 192 && parts[1] === 168);
    }
    if (net.isIPv6(address)) {
        const value = address.toLowerCase();
        return value === '::1' || value === '::' || value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe8') || value.startsWith('fe9') || value.startsWith('fea') || value.startsWith('feb');
    }
    return true;
}

async function validateRemoteImageUrl(value) {
    try {
        const parsed = new URL(String(value));
        if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
            throw new Error('Unsupported image URL');
        }
        const addresses = await dns.lookup(parsed.hostname, { all: true });
        if (!addresses.length || addresses.some(item => isPrivateAddress(item.address))) {
            throw new Error('Private image address is not allowed');
        }
        return parsed.toString();
    } catch (error) {
        error.statusCode = 400;
        throw error;
    }
}

// ================== 基础 API ==================
app.get('/api/image', async (req, res) => {
    const url = req.query.url;
    if (!url) return res.status(400).json({ error: 'Missing image URL' });
    try {
        const imageUrl = await validateRemoteImageUrl(url);
        const response = await axios({
            method: 'GET', url: imageUrl, responseType: 'stream',
            headers: DEFAULT_HEADERS,
            proxy: false, timeout: 15000, maxRedirects: 0, maxContentLength: 10 * 1024 * 1024,
            validateStatus: status => status >= 200 && status < 300
        });
        const contentType = response.headers['content-type'] || '';
        if (!contentType.toLowerCase().startsWith('image/')) {
            response.data.destroy();
            return res.status(415).json({ error: 'Remote resource is not an image' });
        }
        res.setHeader('Content-Type', contentType);
        res.setHeader('Cache-Control', 'public, max-age=86400');
        response.data.pipe(res);
    } catch (err) { res.status(err.statusCode || 500).json({ error: 'Failed to fetch image', detail: err.message }); }
});

app.get('/api/search', async (req, res) => {
    const query = req.query.q;
    if (!query) return res.status(400).json({ error: '缺少搜索词' });
    try {
        const stdout = await runYtDlp(['ytsearch10:' + query, '--dump-json', '--flat-playlist'], 30000);
        const results = stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
        const tracks = results.map(item => ({
            id: item.id, title: toSimpleChinese(item.title || '未知标题'), url: item.webpage_url || (item.id ? `https://www.youtube.com/watch?v=${item.id}` : item.url),
            duration: item.duration_string || '--:--', durationSeconds: item.duration || parseDurationToSeconds(item.duration_string),
            uploader: toSimpleChinese(item.uploader || item.channel || '未知来源'), cover: item.thumbnail || item.thumbnails?.[0]?.url || ''
        })).filter(item => item.url);
        res.json(tracks);
    } catch (err) { res.status(500).json({ error: '搜索失败', detail: err.message }); }
});

// ==========================================
// 🚀 核心改造：音频边下边存，本地直发实现秒切 + LRU清理
// ==========================================

// 自动清理硬盘：最多保留 500 首（按最后活跃时间淘汰）
function cleanupCache() {
    const MAX_FILES = 500;
    fs.readdir(CACHE_DIR, (err, files) => {
        if (err) return;
        const m4aFiles = files.filter(f => f.endsWith('.m4a'));
        if (m4aFiles.length > MAX_FILES) {
            const stats = m4aFiles.map(f => {
                const fp = path.join(CACHE_DIR, f);
                return { file: fp, lastActiveTime: fs.statSync(fp).mtime.getTime() };
            });

            stats.sort((a, b) => a.lastActiveTime - b.lastActiveTime);

            const toDelete = stats.slice(0, m4aFiles.length - MAX_FILES);
            toDelete.forEach(f => {
                try {
                    fs.unlinkSync(f.file);
                    console.log(`🗑️ LRU清理: 删除最久未听的歌曲 -> ${path.basename(f.file)}`);
                } catch (e) {}
            });
        }
    });
}

function isCompleteCacheFile(filePath) {
    try {
        const stats = fs.statSync(filePath);
        return stats.isFile() && stats.size > 0;
    } catch {
        return false;
    }
}

function calculateKiBps(bytes, durationMs) {
    if (!bytes || !durationMs) return 0;
    return Number((bytes / 1024 / (durationMs / 1000)).toFixed(2));
}

// 首次请求只写唯一临时文件，下载完整后再原子发布为可读缓存。
async function ensureLocalAudio(videoUrl, videoId) {
    const finalPath = path.join(CACHE_DIR, `${videoId}.m4a`);
    if (isCompleteCacheFile(finalPath)) {
        console.log(`⚡ [Speed] 命中本地音频缓存，直接分发: ${videoId}`);
        fs.promises.utimes(finalPath, new Date(), new Date()).catch(error => {
            console.error(`⚠️ 更新缓存时间失败: ${error.message}`);
        });
        return { filePath: finalPath, cacheStatus: 'HIT' };
    }

    if (downloadingMap.has(videoId)) {
        console.log(`⏳ 歌曲正在下载中，等待队列... (${videoId})`);
        await downloadingMap.get(videoId);
        if (!isCompleteCacheFile(finalPath)) throw new Error('并发下载结束，但缓存文件不可用');
        return { filePath: finalPath, cacheStatus: 'HIT-WAIT' };
    }

    const downloadPromise = (async () => {
        const startTime = Date.now();
        const tempPath = `${finalPath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
        let failureReason = null;
        console.log(`📥 未命中缓存，开始下载到本地: ${videoId}`);
        try {
            await runYtDlp([
                '--no-playlist',
                '--no-part',
                '--socket-timeout', String(AUDIO_UPSTREAM_TIMEOUT_SECONDS),
                '-q',
                '-f', '140/bestaudio[ext=m4a]',
                '-o', tempPath,
                videoUrl
            ], AUDIO_DOWNLOAD_TIMEOUT_MS);

            const stats = await fs.promises.stat(tempPath);
            if (!stats.isFile() || stats.size === 0) throw new Error('上游下载完成，但临时文件为空');
            await fs.promises.rename(tempPath, finalPath);
            const durationMs = Date.now() - startTime;
            console.log('[audio-cache-fill]', {
                videoId,
                totalBytes: stats.size,
                durationMs,
                averageKiBps: calculateKiBps(stats.size, durationMs),
                reason: 'completed'
            });
        } catch (error) {
            failureReason = error.code || error.message || 'download-failed';
            throw error;
        } finally {
            await fs.promises.rm(tempPath, { force: true }).catch(() => {});
            if (failureReason) {
                console.error('[audio-cache-fill]', {
                    videoId,
                    totalBytes: 0,
                    durationMs: Date.now() - startTime,
                    averageKiBps: 0,
                    reason: failureReason
                });
            }
        }
    })();

    downloadingMap.set(videoId, downloadPromise);
    try {
        await downloadPromise;
    } finally {
        downloadingMap.delete(videoId);
    }

    if (!isCompleteCacheFile(finalPath)) throw new Error('下载流程结束，但未能在本地找到文件');
    return { filePath: finalPath, cacheStatus: 'MISS' };
}

function parseByteRange(rangeHeader, fileSize) {
    if (!rangeHeader) return { start: 0, end: fileSize - 1, partial: false };
    const match = /^bytes=(\d*)-(\d*)$/.exec(String(rangeHeader).trim());
    if (!match || (!match[1] && !match[2])) return null;

    let start;
    let end;
    if (!match[1]) {
        const suffixLength = Number(match[2]);
        if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return null;
        start = Math.max(fileSize - suffixLength, 0);
        end = fileSize - 1;
    } else {
        start = Number(match[1]);
        end = match[2] ? Number(match[2]) : fileSize - 1;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= fileSize) return null;
        end = Math.min(end, fileSize - 1);
    }
    return { start, end, partial: true };
}

function createTransferMetrics(req, res, videoId, requestStartTime) {
    let cacheStatus = 'PENDING';
    let firstByteMs = null;
    let totalBytes = 0;
    let terminalReason = null;
    let logged = false;
    const complete = reason => {
        if (logged) return;
        logged = true;
        const durationMs = Date.now() - requestStartTime;
        console.log('[audio-transfer]', {
            videoId,
            cacheStatus,
            status: res.statusCode,
            range: req.headers.range || null,
            firstByteMs,
            totalBytes,
            durationMs,
            averageKiBps: calculateKiBps(totalBytes, durationMs),
            reason: terminalReason || reason
        });
    };

    res.once('finish', () => complete('completed'));
    res.once('close', () => {
        if (!res.writableFinished) complete(req.aborted ? 'client-aborted' : 'client-disconnected');
    });

    return {
        setCacheStatus(value) { cacheStatus = value; },
        setTerminalReason(value) { terminalReason = value; },
        recordChunk(chunk) {
            if (firstByteMs === null) firstByteMs = Date.now() - requestStartTime;
            totalBytes += chunk.length;
        },
        complete
    };
}

async function sendLocalAudio(req, res, filePath, cacheStatus, metrics) {
    metrics.setCacheStatus(cacheStatus);
    if (res.destroyed) return;
    const stats = await fs.promises.stat(filePath);
    const range = parseByteRange(req.headers.range, stats.size);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', 'audio/mp4');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('X-Audio-Cache', cacheStatus);

    if (!range) {
        res.status(416);
        res.setHeader('Content-Range', `bytes */${stats.size}`);
        res.setHeader('Content-Length', '0');
        return res.end();
    }

    const contentLength = range.end - range.start + 1;
    res.status(range.partial ? 206 : 200);
    res.setHeader('Content-Length', String(contentLength));
    if (range.partial) res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${stats.size}`);
    if (req.method === 'HEAD') return res.end();

    const audioStream = fs.createReadStream(filePath, {
        start: range.start,
        end: range.end,
        highWaterMark: AUDIO_READ_BUFFER_BYTES
    });
    audioStream.on('data', chunk => metrics.recordChunk(chunk));
    pipeline(audioStream, res, error => {
        if (error) metrics.complete(error.code || error.message || 'stream-error');
    });
}

async function handleAudioRequest(req, res, videoId, videoUrl) {
    const requestStartTime = Date.now();
    const metrics = createTransferMetrics(req, res, videoId, requestStartTime);
    const expectedPath = path.join(CACHE_DIR, `${videoId}.m4a`);
    metrics.setCacheStatus(isCompleteCacheFile(expectedPath) ? 'HIT' : (downloadingMap.has(videoId) ? 'HIT-WAIT' : 'MISS'));
    try {
        const { filePath, cacheStatus } = await ensureLocalAudio(videoUrl, videoId);
        await sendLocalAudio(req, res, filePath, cacheStatus, metrics);
        cleanupCache();
    } catch (error) {
        metrics.setTerminalReason(error.code || error.message || 'audio-error');
        console.error('[audio-stream]', {
            videoId,
            code: error.code,
            message: error.message,
            stderr: String(error.stderr || '').slice(0, 2000)
        });
        if (!res.headersSent && !res.destroyed) sendAudioError(res, error);
        else if (!res.destroyed) res.destroy(error);
    }
}

// 按 Video ID 缓存完整音频，后续请求直接从本地磁盘响应。
app.get('/api/stream/:videoId', async (req, res) => {
    const { videoId } = req.params;
    if (!VIDEO_ID_PATTERN.test(videoId)) return res.status(400).json({ error: 'Invalid video ID' });
    await handleAudioRequest(req, res, videoId, `https://www.youtube.com/watch?v=${videoId}`);
});

// 原有明文路由，保留对 /api/stream?url=... 客户端的兼容。
app.get('/api/stream', async (req, res) => {
    const videoUrl = req.query.url;
    // 🌟 AI 埋点：接收 userId
    const title = req.query.title;
    const artist = req.query.artist;
    const userId = req.query.userId || 'guest';

    if (!videoUrl) return res.status(400).json({ error: '缺少URL' });

    const videoId = extractVideoId(videoUrl);
    if (!videoId) return res.status(400).json({ error: '解析 Video ID 失败' });

    console.log(`\n======================================`);
    console.log(`🎵 [Stream] 收到前端播放请求: ${videoId} | User: ${userId}`);

    // 记录 AI 听歌历史到该 userId
    if (title && artist && aiAgent) {
        aiAgent.recordPlayHistory(userId, title, artist);
    }

    try {
        await handleAudioRequest(req, res, videoId, videoUrl);

    } catch (err) {
        console.error(`❌ [Stream] 音频处理失败:`, err.message);
        sendAudioError(res, err);
    }
});

// ==========================================
// 🌟 新增：处理 AI 加密极简短链的流媒体路由
// ==========================================
app.get('/api/s', async (req, res) => {
    if (!aiAgent || !aiAgent.decryptToken) {
        return res.status(503).json({ error: '加密模块未加载或暂不可用' });
    }

    const data = aiAgent.decryptToken(req.query.t);
    if (!data) return res.status(400).send("无效的加密链接");

    // 解析出来的数据都在这里了：
    const { videoId, userId, title } = data;
    const youtubeUrl = `https://www.youtube.com/watch?v=${videoId}`;

    console.log(`\n======================================`);
    console.log(`🎵 [Stream-加密通道] 收到短链播放请求: ${videoId} | User: ${userId}`);

    // 记录 AI 听歌历史 (由于短链压缩去掉了 artist 参数，这里用 'AI推荐' 代偿)
    if (title && aiAgent) {
        aiAgent.recordPlayHistory(userId, title, 'AI推荐');
    }

    try {
        await handleAudioRequest(req, res, videoId, youtubeUrl);

    } catch (err) {
        console.error(`❌ [Stream-加密通道] 音频处理失败:`, err.message);
        sendAudioError(res, err);
    }
});

// ---------------- 智能多源歌词库组件 ----------------
function similarity(a, b) { a = normalizeForCompare(a); b = normalizeForCompare(b); if (!a || !b) return 0; if (a === b) return 1; if (a.includes(b) || b.includes(a)) return Math.max(0.72, Math.min(a.length, b.length) / Math.max(a.length, b.length)); let same = 0; for (const ch of a) { if (b.includes(ch)) same++; } return same / Math.max(a.length, b.length); }
function artistSimilarity(a, b) { const aa = normalizeArtistForCompare(a); const bb = normalizeArtistForCompare(b); if (!aa || !bb) return 0; if (aa === bb) return 1; if (aa.includes(bb) || bb.includes(aa)) return 0.95; return similarity(a, b); }
function isNoisyArtistName(name = '') { const n = String(name).toLowerCase(); return !name.trim() || /studio|lyrics?|lyric|music|channel|official|vevo|topic|records|karaoke/.test(n) || /工作室|歌词|拼音|频道|頻道|音乐|官方|字幕|翻唱/.test(name); }
function isReliableArtist(name = '') { const cleaned = cleanArtistName(name); return !!cleaned && cleaned.length >= 2 && cleaned.length <= 50 && !isNoisyArtistName(cleaned); }
function splitArtistTitle(query = '') { const q = removeNoise(query); let m = q.match(/^(.{1,40}?)(?:的|唱的|演唱的)\s*(.{1,80})$/); if (m) return { artist: cleanArtistName(m[1]), title: removeNoise(m[2]) }; const patterns = [ /^(.*?)\s+-\s+(.*)$/, /^(.*?)\s+\|\s+(.*)$/, /^(.*?)\s+·\s+(.*)$/, /^(.+?)\s+(?:演唱|唱[:：])\s+(.+)$/i, /^(.+?)《(.+?)》/ ]; for (const pattern of patterns) { m = q.match(pattern); if (m && m[1] && m[2] && m[2].length >= 2) return { artist: cleanArtistName(m[1]), title: removeNoise(m[2]) }; } const words = q.split(/\s+/).filter(Boolean); if (words.length >= 2 && words[0].length <= 30) return { artist: cleanArtistName(words[0]), title: removeNoise(words.slice(1).join(' ')) }; return { artist: '', title: q }; }
function extractTitleFromVideoTitle(videoTitle = '', artist = '') { let t = removeNoise(videoTitle); const bracket = String(videoTitle).match(/[《「『【]\s*([^技巧」』】]{1,80})\s*[》」抑】]/); if (bracket && bracket[1]) t = removeNoise(bracket[1]); if (artist) { const escaped = cleanArtistName(artist).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); try { t = t.replace(new RegExp(escaped, 'ig'), ' '); } catch {} } return removeNoise(t); }
function makeQueryCandidates({ q, title, artist, videoTitle }) { const rawQ = removeNoise(q || ''); const rawTitle = removeNoise(title || ''); const rawArtist = cleanArtistName(artist || ''); const fromQ = splitArtistTitle(rawQ); const fromTitle = splitArtistTitle(rawTitle || videoTitle || ''); let finalArtist = isReliableArtist(rawArtist) ? rawArtist : isReliableArtist(fromQ.artist) ? fromQ.artist : isReliableArtist(fromTitle.artist) ? fromTitle.artist : ''; let finalTitle = rawTitle || fromQ.title || fromTitle.title || extractTitleFromVideoTitle(videoTitle, finalArtist); if (rawQ && fromQ.artist && fromQ.title) { if (isReliableArtist(fromQ.artist)) finalArtist = fromQ.artist; finalTitle = fromQ.title; } finalTitle = extractTitleFromVideoTitle(finalTitle, finalArtist) || finalTitle; const compact = []; function pushUnique(v) { v = removeNoise(v); if (v && v.length >= 2 && !compact.includes(v)) compact.push(v); } pushUnique(`${finalArtist} ${finalTitle}`); pushUnique(finalTitle); pushUnique(`${finalTitle} ${finalArtist}`); pushUnique(rawQ); pushUnique(videoTitle); return { artist: finalArtist, title: finalTitle, candidates: compact.slice(0, 5) }; }
function hasTimeTags(lyrics = '') { return /\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?]/.test(lyrics); }
function normalizeLyricText(text = '') { if (!text) return ''; return toSimpleChinese(stripHtmlEntities(text).replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').replace(/\[by:.*?]/gi, '').replace(/\[offset:.*?]/gi, '')).trim(); }
function decodeBase64Maybe(text = '') { if (!text) return ''; try { return Buffer.from(text, 'base64').toString('utf8'); } catch { return text; } }
function lrcListToLrc(list = []) { const out = []; for (const item of list) { const time = Number(item.time); const text = item.lineLyric || item.lyric || item.text || ''; if (!Number.isFinite(time) || !text.trim()) continue; const min = Math.floor(time / 60); const sec = Math.floor(time % 60); const ms = Math.floor((time - Math.floor(time)) * 100); out.push(`[${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(ms).padStart(2, '0')}]${text.trim()}`); } return out.join('\n'); }
function isCandidateAllowed(match, target) { if (!match.lyrics) return false; const titleScore = similarity(match.title || '', target.title || target.q || ''); if (!isReliableArtist(target.artist)) return titleScore >= 0.45; const candidateArtist = match.artist || ''; const artistScore = artistSimilarity(candidateArtist, target.artist || ''); if (!candidateArtist.trim()) return titleScore >= 0.78; if (artistScore < 0.34) return false; return titleScore >= 0.40; }
function scoreCandidate(match, target) { const targetTitle = target.title || target.q || ''; const targetArtist = target.artist || ''; const titleScore = similarity(match.title || '', targetTitle); const queryScore = similarity(`${match.artist || ''} ${match.title || ''}`, `${targetArtist} ${targetTitle}`); const reliableArtist = isReliableArtist(targetArtist); const artistScore = reliableArtist ? artistSimilarity(match.artist || '', targetArtist) : 0.5; let durationScore = 0.5; if (target.duration && match.duration) { const diff = Math.abs(Number(target.duration) - Number(match.duration)); durationScore = diff <= 2 ? 1.0 : diff <= 5 ? 0.85 : diff <= 10 ? 0.60 : diff <= 20 ? 0.30 : 0.05; } const sourceBoost = match.source === 'lrclib' ? 0.05 : match.source === 'qqmusic' ? 0.04 : match.source === 'netease' ? 0.03 : match.source === 'kugou' ? 0.02 : 0; let score = reliableArtist ? titleScore * 0.35 + artistScore * 0.35 + queryScore * 0.10 + durationScore * 0.20 + sourceBoost : titleScore * 0.45 + queryScore * 0.20 + artistScore * 0.10 + durationScore * 0.25 + sourceBoost; if (normalizeForCompare(match.title) === normalizeForCompare(targetTitle)) score += 0.08; if (reliableArtist && artistScore >= 0.8) score += 0.08; if (reliableArtist && artistScore < 0.4) score -= 0.45; if (match.type === 'synced') { score += 0.20; } else { score -= 0.15; } return Math.max(0, Math.min(score, 1)); }

async function searchLrclib(query) { const data = await fetchJson(`https://lrclib.net/api/search?q=${encodeURIComponent(query)}`, {}, 3000); if (!Array.isArray(data)) return []; return data.map(x => ({ source: 'lrclib', title: x.trackName || '', artist: x.artistName || '', album: x.albumName || '', duration: x.duration ? Number(x.duration) : null, type: x.syncedLyrics ? 'synced' : 'plain', lyrics: x.syncedLyrics || x.plainLyrics || '', tlyric: '' })).filter(x => x.lyrics); }
async function searchNetease(query) { const body = new URLSearchParams({ s: query, type: '1', limit: '6', offset: '0', total: 'true', csrf_token: '' }); const data = await fetchJson('https://music.163.com/api/search/get/web', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: 'https://music.163.com/', Origin: 'https://music.163.com' }, body }, 2500); const songs = data?.result?.songs || []; const out = []; for (const s of songs.slice(0, 4)) { const id = s.id; if (!id) continue; const lyricData = await fetchJson(`https://music.163.com/api/song/lyric?id=${id}&lv=1&kv=1&tv=-1`, { headers: { Referer: 'https://music.163.com/' } }, 2000); const lrc = lyricData?.lrc?.lyric || ''; const tlyric = lyricData?.tlyric?.lyric || ''; if (!lrc) continue; out.push({ source: 'netease', title: s.name || '', artist: (s.artists || []).map(a => a.name).join(' / '), album: s.album?.name || '', duration: s.duration ? Math.round(s.duration / 1000) : null, type: hasTimeTags(lrc) ? 'synced' : 'plain', lyrics: normalizeLyricText(lrc), tlyric: normalizeLyricText(tlyric) }); } return out; }
async function searchQQMusic(query) { const searchUrl = 'https://c.y.qq.com/soso/fcgi-bin/client_search_cp?' + new URLSearchParams({ ct: '24', qqmusic_ver: '1298', new_json: '1', remoteplace: 'txt.yqq.song', searchid: String(Date.now()).slice(-8), t: '0', aggr: '1', cr: '1', catZhida: '1', lossless: '0', flag_qc: '0', p: '1', n: '8', w: query, format: 'json' }); let data = await fetchJson(searchUrl, { headers: { Referer: 'https://y.qq.com/', Origin: 'https://y.qq.com' } }, 2500); if (typeof data === 'string') { try { const m = data.match(/^[^\(]*\((.*)\)\s*$/); if (m && m[1]) data = JSON.parse(m[1]); } catch {} } const list = data?.data?.song?.list || []; const out = []; for (const s of list.slice(0, 5)) { const songmid = s.mid || s.songmid; if (!songmid) continue; const lyricUrl = 'https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?' + new URLSearchParams({ songmid, format: 'json', nobase64: '1', g_tk: '5381' }); let lyricData = await fetchJson(lyricUrl, { headers: { Referer: 'https://y.qq.com/portal/player.html', Origin: 'https://y.qq.com' } }, 2000); if (typeof lyricData === 'string') { try { const m = lyricData.match(/^[^\(]*\((.*)\)\s*$/); if (m && m[1]) lyricData = JSON.parse(m[1]); } catch {} } let lyric = lyricData?.lyric || lyricData?.data?.lyric || ''; let tlyric = lyricData?.trans || lyricData?.data?.trans || ''; if (lyric && /^[A-Za-z0-9+/=\s]+$/.test(lyric.slice(0, 80))) { const decoded = decodeBase64Maybe(lyric); if (decoded && decoded.length > lyric.length * 0.5) lyric = decoded; } if (tlyric && /^[A-Za-z0-9+/=\s]+$/.test(tlyric.slice(0, 80))) { const decodedT = decodeBase64Maybe(tlyric); if (decodedT) tlyric = decodedT; } if (!lyric) continue; const singers = (s.singer || []).map(a => a.name).join(' / '); out.push({ source: 'qqmusic', title: s.name || s.songname || '', artist: singers, album: s.album?.name || s.albumname || '', duration: s.interval || null, type: hasTimeTags(lyric) ? 'synced' : 'plain', lyrics: normalizeLyricText(lyric), tlyric: normalizeLyricText(tlyric) }); } return out; }
async function searchKugou(query) { const searchUrl = 'http://mobilecdn.kugou.com/api/v3/search/song?' + new URLSearchParams({ format: 'json', keyword: query, page: '1', pagesize: '8', showtype: '1' }); const data = await fetchJson(searchUrl, {}, 2500); const list = data?.data?.info || []; const out = []; for (const s of list.slice(0, 5)) { const title = s.songname || s.song_name || s.filename || ''; const artist = s.singername || s.singer_name || ''; const hash = s.hash || s.FileHash || s.filehash || ''; const duration = Number(s.duration || s.Duration || 0) || null; const keyword = `${artist} ${title}`.trim() || query; const lyricSearchUrl = 'http://lyrics.kugou.com/search?' + new URLSearchParams({ ver: '1', man: 'yes', client: 'pc', keyword, duration: duration ? String(duration * 1000) : '', hash }); const lyricSearch = await fetchJson(lyricSearchUrl, {}, 2000); const candidates = lyricSearch?.candidates || []; if (!candidates.length) continue; const bestLyric = candidates[0]; const downloadUrl = 'http://lyrics.kugou.com/download?' + new URLSearchParams({ ver: '1', client: 'pc', id: bestLyric.id, accesskey: bestLyric.accesskey, fmt: 'lrc', charset: 'utf8' }); const lyricData = await fetchJson(downloadUrl, {}, 2000); let lyric = lyricData?.content || ''; if (lyric) lyric = decodeBase64Maybe(lyric); if (!lyric) continue; out.push({ source: 'kugou', title, artist, album: s.album_name || s.album || '', duration, type: hasTimeTags(lyric) ? 'synced' : 'plain', lyrics: normalizeLyricText(lyric), tlyric: '' }); } return out; }
async function searchKuwo(query) { const searchUrl = 'http://search.kuwo.cn/r.s?' + new URLSearchParams({ all: query, ft: 'music', itemset: 'web_2013', client: 'kt', pn: '0', rn: '8', rformat: 'json', encoding: 'utf8' }); const data = await fetchJson(searchUrl, {}, 2500); const list = data?.abslist || []; const out = []; for (const s of list.slice(0, 5)) { let rid = s.MUSICRID || s.musicrid || s.id || ''; rid = String(rid).replace(/^MUSIC_?/i, '').replace(/\D/g, ''); if (!rid) continue; const lyricData = await fetchJson(`http://m.kuwo.cn/newh5/singles/songinfoandlrc?musicId=${encodeURIComponent(rid)}`, { headers: { Referer: 'http://m.kuwo.cn/' } }, 2000); const lrclist = lyricData?.data?.lrclist || []; const lyric = Array.isArray(lrclist) && lrclist.length ? lrcListToLrc(lrclist) : (lyricData?.data?.lrc || ''); if (!lyric) continue; out.push({ source: 'kuwo', title: s.SONGNAME || s.name || '', artist: s.ARTIST || s.artist || '', album: s.ALBUM || s.album || '', duration: s.DURATION ? parseDurationToSeconds(s.DURATION) : null, type: hasTimeTags(lyric) ? 'synced' : 'plain', lyrics: normalizeLyricText(lyric), tlyric: '' }); } return out; }

async function trySource(sourceName, fn, queries, target, maxQueries = 2) {
    const tried = []; let allRaw = [];
    for (const q of queries.slice(0, maxQueries)) {
        tried.push(`${sourceName}:${q}`);
        let list = []; try { list = await fn(q); } catch (err) { continue; }
        if (!list || !list.length) continue;
        for (const item of list) { if (item && item.lyrics) { allRaw.push(item); } }
    }
    return { allRaw, tried };
}

async function collectLyrics(target) {
    const sources = [ ['lrclib', searchLrclib, 2], ['netease', searchNetease, 1], ['qqmusic', searchQQMusic, 2], ['kugou', searchKugou, 2], ['kuwo', searchKuwo, 2] ];
    const promises = sources.map(([name, fn, maxQueries]) => trySource(name, fn, target.candidates, target, maxQueries));
    const results = await Promise.allSettled(promises);
    let pool = []; let tried = [];
    for (const res of results) { if (res.status === 'fulfilled') { pool = pool.concat(res.value.allRaw); tried.push(...res.value.tried); } }
    let strictScored = pool.filter(item => isCandidateAllowed(item, target)).map(item => ({ ...item, score: scoreCandidate(item, target) }));
    if (strictScored.length > 0) {
        strictScored.sort((a, b) => b.score - a.score);
        return { best: strictScored[0], scored: strictScored.slice(0, 10), tried };
    }
    let looseScored = pool.filter(item => similarity(item.title || '', target.title || target.q || '') >= 0.32).map(item => {
        const baseScore = similarity(item.title || '', target.title || target.q || '');
        return { ...item, score: baseScore * 0.6 };
    });
    if (looseScored.length > 0) {
        looseScored.sort((a, b) => b.score - a.score);
        return { best: looseScored[0], scored: looseScored.slice(0, 10), tried };
    }
    return { best: null, scored: [], tried };
}

async function fetchJson(url, options = {}, timeout = 2500) {
    const source = axios.CancelToken.source();
    const timer = setTimeout(() => source.cancel(`Timeout of ${timeout}ms`), timeout);
    try {
        const config = { url, method: options.method || 'GET', headers: { ...DEFAULT_HEADERS, ...(options.headers || {}) }, data: options.body, proxy: false, cancelToken: source.token, validateStatus: () => true };
        const res = await axios(config);
        clearTimeout(timer); return res.data;
    } catch (e) { clearTimeout(timer); return null; }
}

app.get('/api/lyrics', async (req, res) => {
    const raw = { q: req.query.q || '', title: req.query.title || '', artist: req.query.artist || '', videoTitle: req.query.videoTitle || req.query.title || '', videoUrl: req.query.videoUrl || '', duration: parseDurationToSeconds(req.query.duration || req.query.durationSeconds) };
    if (!raw.q && !raw.title && !raw.videoTitle) { return res.json({ lyrics: null, tlyric: null, type: null, source: null, tried: [] }); }
    const info = makeQueryCandidates(raw);
    const target = { ...raw, artist: info.artist || cleanArtistName(raw.artist), title: info.title || removeNoise(raw.title || raw.q || raw.videoTitle), candidates: info.candidates };
    const key = JSON.stringify({ version: LYRIC_ALGO_VERSION, q: raw.q, title: target.title, artist: target.artist, duration: raw.duration });
    const cached = lyricCache.get(key);
    if (cached && Date.now() - cached.time < LYRIC_CACHE_TTL) { return res.json({ ...cached.value, cached: true }); }
    try {
        const { best, scored, tried } = await collectLyrics(target);
        if (best && (!best.tlyric || !best.tlyric.trim())) {
            const hasTranslation = scored.find(x => x.tlyric && x.tlyric.trim());
            if (hasTranslation) { best.tlyric = hasTranslation.tlyric; }
        }
        const value = best ? {
            lyrics: normalizeLyricText(best.lyrics), tlyric: normalizeLyricText(best.tlyric || ''), type: best.type || (hasTimeTags(best.lyrics) ? 'synced' : 'plain'),
            source: best.source, matchedTitle: toSimpleChinese(best.title || ''), matchedArtist: toSimpleChinese(best.artist || ''),
            score: Number(best.score.toFixed(3)), rejectedCount: 0, targetTitle: target.title, targetArtist: target.artist,
            candidates: target.candidates, alternatives: scored.map(x => ({ source: x.source, title: toSimpleChinese(x.title || ''), artist: toSimpleChinese(x.artist || ''), score: Number(x.score.toFixed(3)), type: x.type })), tried
        } : { lyrics: null, tlyric: null, type: null, source: null, rejectedCount: 0, targetTitle: target.title, targetArtist: target.artist, candidates: target.candidates, alternatives: scored.map(x => ({ source: x.source, title: toSimpleChinese(x.title || ''), artist: toSimpleChinese(x.artist || ''), score: Number(x.score.toFixed(3)), type: x.type })), tried };
        lyricCache.set(key, { time: Date.now(), value });
        res.json(value);
    } catch (err) { res.status(500).json({ error: '歌词聚合失败', detail: err.message }); }
});

// ==========================================
// 🌟 云端账号数据隔离系统 (带密码保护)
// ==========================================
const SYNC_FILE = path.join(__dirname, 'aura_sync_data.json');

function loadSyncData() {
    try { return JSON.parse(fs.readFileSync(SYNC_FILE, 'utf8')); }
    catch(e) { return {}; }
}
function saveSyncData(data) {
    const tempFile = `${SYNC_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tempFile, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tempFile, SYNC_FILE);
}

const PASSWORD_PREFIX = 'scrypt-v1';

function hashPassword(password) {
    const salt = crypto.randomBytes(16);
    const derivedKey = crypto.scryptSync(String(password), salt, 64);
    return `${PASSWORD_PREFIX}$${salt.toString('base64url')}$${derivedKey.toString('base64url')}`;
}

function verifyPassword(password, storedPassword) {
    if (!storedPassword) return false;
    if (!String(storedPassword).startsWith(`${PASSWORD_PREFIX}$`)) {
        const supplied = Buffer.from(String(password));
        const stored = Buffer.from(String(storedPassword));
        return supplied.length === stored.length && crypto.timingSafeEqual(supplied, stored);
    }
    try {
        const [, saltValue, keyValue] = String(storedPassword).split('$');
        const expected = Buffer.from(keyValue, 'base64url');
        const actual = crypto.scryptSync(String(password), Buffer.from(saltValue, 'base64url'), expected.length);
        return crypto.timingSafeEqual(actual, expected);
    } catch {
        return false;
    }
}

function migrateStoredPasswords() {
    const data = loadSyncData();
    let changed = false;
    for (const account of Object.values(data)) {
        if (account?.password && !String(account.password).startsWith(`${PASSWORD_PREFIX}$`)) {
            account.password = hashPassword(account.password);
            changed = true;
        }
    }
    if (changed) saveSyncData(data);
}

migrateStoredPasswords();

// 🌟 核心修改：账号安全认证接口 (合并登录与校验)
app.post('/api/user/auth', (req, res) => {
    const { userId, password } = req.body;
    if(!userId) return res.status(400).json({error: '账号缺失'});
    if(!password) return res.status(400).json({error: '密码不能为空'});

    const data = loadSyncData();
    if(data[userId]) {
        // 账号已存在
        if (data[userId].password) {
            // 已有密码，进行校验
            if (!verifyPassword(password, data[userId].password)) {
                return res.status(401).json({ success: false, error: '密码错误' });
            }
        } else {
            // 【无感升级机制】：老用户在云端没有密码，本次输入的密码将直接绑定为永久密码
            data[userId].password = hashPassword(password);
            saveSyncData(data);
        }
        res.json({ success: true, exists: true, favorites: data[userId].favorites || [] });
    } else {
        // 账号完全不存在
        res.json({ success: true, exists: false, favorites: [] });
    }
});

// 静默同步保存接口 (增加密码校验防篡改)
app.post('/api/user/favorites', (req, res) => {
    const { userId, password, favorites } = req.body;
    if(!userId || !password || !Array.isArray(favorites)) return res.status(400).json({error: '参数缺失'});

    const data = loadSyncData();

    // 防止绕过登录直接发包修改别人的歌单
    if (data[userId] && data[userId].password && !verifyPassword(password, data[userId].password)) {
        return res.status(401).json({ error: '安全验证失败，拒绝同步' });
    }

    data[userId] = {
        password: data[userId]?.password || hashPassword(password),
        favorites,
        updated: new Date().toISOString()
    };
    saveSyncData(data);
    res.json({ success: true, message: '同步成功' });
});


// ==========================================
// 🤖 暴露给前端的 AI 助手 API (绑定 User ID)
// ==========================================

// 获取首页智能推荐
app.get('/api/ai/recommend', async (req, res) => {
    if (!aiAgent) return res.status(503).json({ error: 'AI 服务未启用' });
    const userId = req.query.userId || 'guest';
    try {
        const recommendations = await aiAgent.getRecommendations(userId);
        res.json({ success: true, data: recommendations });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// AI 智能问答
app.post('/api/ai/chat', async (req, res) => {
    if (!aiAgent) return res.status(503).json({ error: 'AI 服务未启用' });
    const { userId, message } = req.body;
    if (!message) return res.status(400).json({ error: '缺少消息内容' });

    try {
        const reply = await aiAgent.chatWithAI(userId || 'guest', message);
        res.json({ success: true, reply });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// 手动上报听歌历史 (预留给前端调用)
app.post('/api/ai/history', (req, res) => {
    if (!aiAgent) return res.status(503).json({ error: 'AI 服务未启用' });
    const { userId, title, artist } = req.body;
    if (title && artist) {
        aiAgent.recordPlayHistory(userId || 'guest', title, artist);
        return res.json({ success: true });
    }
    res.status(400).json({ error: '参数缺失' });
});

function startServer(port = PORT, host = '0.0.0.0') {
    const server = app.listen(port, host, () => {
        const address = server.address();
        const listeningPort = address && typeof address === 'object' ? address.port : port;
        console.log(`🎵 Aura 后端运行成功 | 端口: ${listeningPort}`);
        console.log(`🗂️  音频缓存目录已就绪: ${CACHE_DIR}`);
    });
    return server;
}

if (require.main === module) {
    startServer();
}

module.exports = { app, startServer, parseByteRange };
