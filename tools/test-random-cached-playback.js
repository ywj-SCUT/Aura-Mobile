const { execFileSync } = require('child_process');

const ADB = process.env.ADB || 'C:\\Android\\Sdk\\platform-tools\\adb.exe';
const PACKAGE = 'com.YWJ.Aura';
const ACTIVITY = `${PACKAGE}/.MainActivity`;
const VIDEO_ID = process.env.VIDEO_ID;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function adb(...args) {
    return execFileSync(ADB, args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true
    }).trim();
}

function shell(command) {
    return adb('shell', command);
}

function mediaSnapshot(stage) {
    const dump = shell('dumpsys media_session');
    const states = [...dump.matchAll(/state=PlaybackState \{state=(\d+), position=(\d+), buffered position=\d+, speed=([\d.]+), updated=(\d+)/g)];
    const descriptions = [...dump.matchAll(/description=([^,\r\n]+),\s*([^,\r\n]+)/g)];
    const state = states.at(-1);
    const description = descriptions.at(-1);
    const uptimeMs = Number.parseFloat(shell('cat /proc/uptime').split(/\s+/)[0]) * 1000;
    const basePositionMs = state ? Number(state[2]) : null;
    const speed = state ? Number(state[3]) : 0;
    const updatedMs = state ? Number(state[4]) : null;
    const estimatedPositionMs = state && Number(state[1]) === 3
        ? Math.round(basePositionMs + Math.max(0, uptimeMs - updatedMs) * speed)
        : basePositionMs;
    return {
        stage,
        state: state ? Number(state[1]) : null,
        basePositionMs,
        estimatedPositionMs,
        updatedMs,
        uptimeMs: Math.round(uptimeMs),
        title: description?.[1]?.trim() || '',
        artist: description?.[2]?.trim() || ''
    };
}

async function cdpEvaluate(expression) {
    const targets = await fetch('http://127.0.0.1:9222/json').then(response => response.json());
    const target = targets.find(item => item.type === 'page' && item.url === 'http://localhost/') || targets[0];
    if (!target?.webSocketDebuggerUrl) throw new Error('Aura WebView CDP target is unavailable');

    return new Promise((resolve, reject) => {
        const socket = new WebSocket(target.webSocketDebuggerUrl);
        const timeout = setTimeout(() => reject(new Error('CDP evaluation timed out')), 10000);
        socket.onopen = () => socket.send(JSON.stringify({
            id: 1,
            method: 'Runtime.evaluate',
            params: { expression, returnByValue: true }
        }));
        socket.onerror = () => reject(new Error('CDP WebSocket failed'));
        socket.onmessage = event => {
            const message = JSON.parse(event.data);
            if (message.id !== 1) return;
            clearTimeout(timeout);
            socket.onerror = null;
            socket.onclose = null;
            socket.close();
            resolve(message.result?.result?.value);
        };
    });
}

async function clickFavorite(videoId) {
    const result = await cdpEvaluate(`(() => {
        const favorites = JSON.parse(localStorage.getItem('aura_favorites') || '[]');
        const index = favorites.findIndex(song => String(song.id || song.videoId || '') === ${JSON.stringify(videoId)});
        const search = document.getElementById('fav-search-input');
        if (search && search.value) {
            search.value = '';
            search.dispatchEvent(new Event('input', { bubbles: true }));
        }
        const button = [...document.querySelectorAll('.fav-title')][index]?.closest('button.track-select-button');
        if (!button) return JSON.stringify({ ok: false, index });
        button.click();
        return JSON.stringify({ ok: true, index, title: favorites[index].title || '' });
    })()`);
    const parsed = JSON.parse(result);
    if (!parsed.ok) throw new Error(`Favorite click failed: ${result}`);
    return parsed;
}

async function main() {
    if (!VIDEO_ID) throw new Error('VIDEO_ID is required');
    const snapshots = [];
    try {
        shell('input keyevent KEYCODE_WAKEUP');
        shell('wm dismiss-keyguard');
        shell(`am start -n ${ACTIVITY}`);
        await sleep(1000);
        adb('logcat', '-c');

        const selected = await clickFavorite(VIDEO_ID);
        await sleep(3000);
        snapshots.push(mediaSnapshot('foreground'));

        shell('input keyevent KEYCODE_HOME');
        await sleep(15000);
        snapshots.push(mediaSnapshot('home-background'));

        shell('input keyevent KEYCODE_POWER');
        await sleep(15000);
        snapshots.push(mediaSnapshot('locked'));

        const power = shell('dumpsys power');
        const wifi = shell('dumpsys wifi');
        const services = shell(`dumpsys activity services ${PACKAGE}`);
        const pid = shell(`pidof ${PACKAGE}`);
        const logs = adb('logcat', '-d', '-v', 'time', `--pid=${pid}`)
            .split(/\r?\n/)
            .filter(line => /Audio source=|SWAP_Scene FREEZE|SocketException|UnknownHostException|播放音频失败/.test(line));

        console.log(JSON.stringify({
            selected,
            snapshots,
            wakefulness: power.match(/mWakefulness=([^\r\n]+)/)?.[1]?.trim() || '',
            cpuWakeLock: power.includes('AuraMusic::NativeWakeLock'),
            wifiLock: wifi.includes('AuraMusic::NativeWifiLock'),
            exoWifiLock: wifi.includes('ExoPlayer:WifiLockManager'),
            foregroundService: /isForeground=true/.test(services),
            logs
        }, null, 2));
    } finally {
        shell('input keyevent KEYCODE_WAKEUP');
        shell('wm dismiss-keyguard');
        shell(`am start -n ${ACTIVITY}`);
        await sleep(1000);
        shell('input keyevent KEYCODE_MEDIA_PAUSE');
        shell('svc power stayon false');
    }
}

main().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
});
