const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { writeFileSync } = require('fs');

const ADB = process.env.ADB || 'C:\\Android\\Sdk\\platform-tools\\adb.exe';
const CDP_LIST_URL = 'http://127.0.0.1:9222/json';
const API_BASE = process.env.API_BASE || 'http://YOUR_SERVER_IP:3000/api';
const PACKAGE = 'com.YWJ.Aura';
const ACTIVITY = `${PACKAGE}/.MainActivity`;
const AUDIO_DIR = `/storage/emulated/0/Android/data/${PACKAGE}/files/audio-library`;
const START_AFTER_ID = 'V2E1FceLBSA';
const ONLY_IDS = (process.env.ONLY_IDS || '').split(',').map(value => value.trim()).filter(Boolean);
const POLL_INTERVAL_MS = 3000;
const REPORT_INTERVAL_MS = 30000;
const STALL_RETRY_MS = 75000;
const TRACK_TIMEOUT_MS = 20 * 60 * 1000;
const BACKEND_PROBE_AFTER_MS = 30000;

function timestamp() {
    return new Date().toLocaleString('sv-SE', { hour12: false });
}

function log(message) {
    process.stdout.write(`[${timestamp()}] ${message}\n`);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function adb(...args) {
    return execFileSync(ADB, args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
    }).trim();
}

function adbShell(command) {
    return adb('shell', command);
}

function md5(value) {
    return crypto.createHash('md5').update(value, 'utf8').digest('hex');
}

function cacheNames(song, userId) {
    const title = song.title || song.lyricTitle || '未知歌曲';
    const artist = song.uploader || song.artist || song.lyricArtist || '未知歌手';
    const stableName = `${md5(`aura-cache-v2:id:${song.id}`)}.aura`;
    const legacyUrl = `${API_BASE}/stream?url=${encodeURIComponent(song.url || '')}`
        + `&title=${encodeURIComponent(song.title || title)}`
        + `&artist=${encodeURIComponent(song.uploader || song.artist || artist)}`
        + `&userId=${encodeURIComponent(userId)}`;
    return {
        stableName,
        legacyName: `${md5(legacyUrl)}.aura`
    };
}

function fileSize(path) {
    const result = adbShell(`if [ -f '${path}' ]; then stat -c %s '${path}'; else echo -1; fi`);
    const size = Number(result);
    return Number.isFinite(size) ? size : -1;
}

function cacheState(song, userId) {
    const names = cacheNames(song, userId);
    const stablePath = `${AUDIO_DIR}/${names.stableName}`;
    const legacyPath = `${AUDIO_DIR}/${names.legacyName}`;
    const stableSize = fileSize(stablePath);
    const legacySize = fileSize(legacyPath);
    const partialSize = fileSize(`${stablePath}.download`);
    return {
        ...names,
        stablePath,
        complete: stableSize >= 0 || legacySize >= 0,
        completeSize: Math.max(stableSize, legacySize),
        partialSize
    };
}

async function cdpEvaluate(expression) {
    const targets = await fetch(CDP_LIST_URL).then(response => response.json());
    const target = targets.find(item => item.type === 'page' && item.url === 'http://localhost/') || targets[0];
    if (!target?.webSocketDebuggerUrl) {
        throw new Error('Aura WebView CDP target is unavailable');
    }

    return new Promise((resolve, reject) => {
        const socket = new WebSocket(target.webSocketDebuggerUrl);
        const timeout = setTimeout(() => {
            socket.close();
            reject(new Error('CDP evaluation timed out'));
        }, 10000);

        socket.onopen = () => {
            socket.send(JSON.stringify({
                id: 1,
                method: 'Runtime.evaluate',
                params: { expression, returnByValue: true, awaitPromise: true }
            }));
        };
        socket.onerror = () => {
            clearTimeout(timeout);
            reject(new Error('CDP WebSocket failed'));
        };
        socket.onmessage = event => {
            const message = JSON.parse(event.data);
            if (message.id !== 1) return;
            clearTimeout(timeout);
            const result = message.result?.result;
            socket.onclose = null;
            socket.close();
            if (result?.subtype === 'error') {
                reject(new Error(result.description || 'CDP evaluation failed'));
                return;
            }
            resolve(result?.value);
        };
    });
}

async function loadLibrary() {
    const value = await cdpEvaluate(`JSON.stringify({
        userId: localStorage.getItem('aura_userId') || 'guest',
        favorites: JSON.parse(localStorage.getItem('aura_favorites') || '[]')
    })`);
    return JSON.parse(value);
}

async function bringAuraToForeground() {
    adbShell('input keyevent KEYCODE_WAKEUP');
    adbShell('wm dismiss-keyguard');
    adbShell(`am start -n ${ACTIVITY}`);
    await sleep(800);
}

async function clickFavorite(videoId) {
    const result = await cdpEvaluate(`(() => {
        const favorites = JSON.parse(localStorage.getItem('aura_favorites') || '[]');
        const index = favorites.findIndex(song => String(song.id || song.videoId || '') === ${JSON.stringify(videoId)});
        if (index < 0) return JSON.stringify({ ok: false, reason: 'favorite-missing' });
        if (!document.getElementById('page-fav')?.classList.contains('active')) {
            document.querySelector('.nav-item[data-target="page-fav"]')?.click();
        }
        const search = document.getElementById('fav-search-input');
        if (search && search.value) {
            search.value = '';
            search.dispatchEvent(new Event('input', { bubbles: true }));
        }
        const buttons = [...document.querySelectorAll('.fav-title')].map(node => node.closest('button.track-select-button'));
        const button = buttons[index];
        if (!button) return JSON.stringify({ ok: false, reason: 'button-missing', index, count: buttons.length });
        button.click();
        return JSON.stringify({ ok: true, index, title: favorites[index].title || '' });
    })()`);
    const parsed = JSON.parse(result);
    if (!parsed.ok) {
        throw new Error(`Unable to click favorite ${videoId}: ${JSON.stringify(parsed)}`);
    }
}

async function probeBackend(videoId) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
        const response = await fetch(`${API_BASE}/stream/${encodeURIComponent(videoId)}`, {
            headers: { Range: 'bytes=0-0' },
            cache: 'no-store',
            signal: controller.signal
        });
        if (response.ok) {
            await response.body?.cancel();
            return { ok: true, status: response.status };
        }
        const detail = (await response.text()).replace(/\s+/g, ' ').trim().slice(0, 500);
        return { ok: false, status: response.status, detail };
    } catch (error) {
        return { ok: null, status: 0, detail: error.name === 'AbortError' ? 'probe-timeout' : error.message };
    } finally {
        clearTimeout(timeout);
    }
}

async function cacheTrack(song, userId, position, total) {
    let state = cacheState(song, userId);
    if (state.complete) {
        log(`SKIP ${position}/${total} ${song.id} ${song.title} (${state.completeSize} bytes)`);
        return { skipped: true, size: state.completeSize };
    }

    await bringAuraToForeground();
    await clickFavorite(song.id);
    const startedAt = Date.now();
    let lastProgressAt = startedAt;
    let lastReportAt = 0;
    let lastSize = state.partialSize;
    let retries = 0;
    let zeroByteProbeCompleted = false;
    log(`START ${position}/${total} ${song.id} ${song.title} partial=${Math.max(0, lastSize)}`);

    while (Date.now() - startedAt < TRACK_TIMEOUT_MS) {
        await sleep(POLL_INTERVAL_MS);
        state = cacheState(song, userId);
        if (state.complete) {
            const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
            log(`DONE ${position}/${total} ${song.id} ${song.title} bytes=${state.completeSize} seconds=${seconds} retries=${retries}`);
            return { skipped: false, size: state.completeSize, seconds: Number(seconds), retries };
        }

        const currentSize = Math.max(0, state.partialSize);
        if (currentSize > lastSize) {
            lastSize = currentSize;
            lastProgressAt = Date.now();
        }
        if (Date.now() - lastReportAt >= REPORT_INTERVAL_MS) {
            const seconds = Math.floor((Date.now() - startedAt) / 1000);
            log(`PROGRESS ${position}/${total} ${song.id} bytes=${currentSize} elapsed=${seconds}s`);
            lastReportAt = Date.now();
        }
        if (currentSize === 0
            && !zeroByteProbeCompleted
            && Date.now() - lastProgressAt >= BACKEND_PROBE_AFTER_MS) {
            zeroByteProbeCompleted = true;
            const probe = await probeBackend(song.id);
            if (probe.ok === false) {
                const reason = `HTTP ${probe.status} ${probe.detail}`;
                log(`FAIL ${position}/${total} ${song.id} ${song.title} reason=${reason}`);
                return { failed: true, size: 0, reason };
            }
            log(`PROBE ${position}/${total} ${song.id} status=${probe.status || probe.detail} continuing=true`);
        }
        if (Date.now() - lastProgressAt >= STALL_RETRY_MS) {
            retries += 1;
            log(`RETRY ${position}/${total} ${song.id} stalledBytes=${currentSize} retry=${retries}`);
            await bringAuraToForeground();
            await clickFavorite(song.id);
            lastProgressAt = Date.now();
        }
    }

    const reason = `timed out after ${TRACK_TIMEOUT_MS / 60000} minutes`;
    log(`FAIL ${position}/${total} ${song.id} ${song.title} reason=${reason}`);
    return { failed: true, size: 0, reason };
}

async function main() {
    adb('devices');
    adbShell('svc power stayon true');
    await bringAuraToForeground();

    const library = await loadLibrary();
    const startIndex = library.favorites.findIndex(song => song.id === START_AFTER_ID);
    if (startIndex < 0) {
        throw new Error(`Start marker ${START_AFTER_ID} was not found in favorites`);
    }

    const targets = ONLY_IDS.length > 0
        ? ONLY_IDS.map(id => library.favorites.find(song => song.id === id)).filter(Boolean)
        : library.favorites.slice(startIndex + 1);
    if (ONLY_IDS.length > 0 && targets.length !== ONLY_IDS.length) {
        throw new Error('At least one ONLY_IDS entry was not found in favorites');
    }
    const initial = targets.map(song => cacheState(song, library.userId));
    const pendingCount = initial.filter(state => !state.complete).length;
    const scope = ONLY_IDS.length > 0 ? 'selected' : 'afterNewYork';
    log(`BATCH favorites=${library.favorites.length} ${scope}=${targets.length} pending=${pendingCount} alreadyComplete=${targets.length - pendingCount}`);

    let downloaded = 0;
    let skipped = 0;
    const failures = [];
    let bytes = 0;
    for (let index = 0; index < targets.length; index += 1) {
        const result = await cacheTrack(targets[index], library.userId, index + 1, targets.length);
        bytes += result.size || 0;
        if (result.failed) failures.push({
            id: targets[index].id,
            title: targets[index].title,
            reason: result.reason
        });
        else if (result.skipped) skipped += 1;
        else downloaded += 1;
    }

    const failureFile = ONLY_IDS.length > 0
        ? 'cache-favorites-supplement-failures.json'
        : 'cache-favorites-failures.json';
    writeFileSync(failureFile, `${JSON.stringify(failures, null, 2)}\n`, 'utf8');
    log(`BATCH_DONE total=${targets.length} downloaded=${downloaded} skipped=${skipped} failed=${failures.length} bytes=${bytes}`);
}

main().catch(error => {
    console.error(`[${timestamp()}] FATAL ${error.stack || error.message}`);
    process.exitCode = 1;
});
