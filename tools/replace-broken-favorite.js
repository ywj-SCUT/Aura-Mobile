const { writeFileSync } = require('fs');

const OLD_ID = 'eKpegiG5XJc';
const NEW_ID = 'WMREk23N5BM';
const API_BASE = 'http://47.77.230.218:3000/api';

async function cdpEvaluate(expression) {
    const targets = await fetch('http://127.0.0.1:9222/json').then(response => response.json());
    const target = targets.find(item => item.type === 'page' && item.url === 'http://localhost/') || targets[0];
    if (!target?.webSocketDebuggerUrl) throw new Error('Aura WebView CDP target is unavailable');

    return new Promise((resolve, reject) => {
        const socket = new WebSocket(target.webSocketDebuggerUrl);
        const timeout = setTimeout(() => reject(new Error('CDP evaluation timed out')), 30000);
        socket.onopen = () => socket.send(JSON.stringify({
            id: 1,
            method: 'Runtime.evaluate',
            params: { expression, returnByValue: true, awaitPromise: true }
        }));
        socket.onerror = () => reject(new Error('CDP WebSocket failed'));
        socket.onmessage = event => {
            const message = JSON.parse(event.data);
            if (message.id !== 1) return;
            clearTimeout(timeout);
            socket.onerror = null;
            socket.onclose = null;
            socket.close();
            const result = message.result?.result;
            if (result?.subtype === 'error') {
                reject(new Error(result.description || 'CDP evaluation failed'));
                return;
            }
            resolve(result?.value);
        };
    });
}

async function main() {
    const result = await cdpEvaluate(`(async () => {
        const favorites = JSON.parse(localStorage.getItem('aura_favorites') || '[]');
        const index = favorites.findIndex(song => song.id === ${JSON.stringify(OLD_ID)});
        if (index < 0) return JSON.stringify({ ok: false, error: 'old favorite not found' });
        const oldFavorite = favorites[index];
        const replacement = {
            ...oldFavorite,
            id: ${JSON.stringify(NEW_ID)},
            videoId: ${JSON.stringify(NEW_ID)},
            url: 'https://www.youtube.com/watch?v=${NEW_ID}',
            cover: 'https://i.ytimg.com/vi/${NEW_ID}/hqdefault.jpg',
            videoTitle: '海街寺庙'
        };
        const updated = [...favorites];
        updated[index] = replacement;
        const userId = localStorage.getItem('aura_userId') || 'guest';
        const password = localStorage.getItem('aura_password') || '';
        const revision = (Number(localStorage.getItem('aura_favorites_revision')) || 0) + 1;
        const response = await fetch('${API_BASE}/user/favorites', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            cache: 'no-store',
            body: JSON.stringify({ userId, password, favorites: updated, revision })
        });
        const data = await response.json();
        if (!response.ok || data.success !== true) {
            return JSON.stringify({ ok: false, error: data.error || data.message || 'cloud update failed' });
        }
        const verifyResponse = await fetch('${API_BASE}/user/auth', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            cache: 'no-store',
            body: JSON.stringify({ userId, password })
        });
        const verify = await verifyResponse.json();
        const cloudFavorites = Array.isArray(verify.favorites) ? verify.favorites : [];
        if (!verifyResponse.ok
            || verify.success !== true
            || !cloudFavorites.some(song => song.id === ${JSON.stringify(NEW_ID)})
            || cloudFavorites.some(song => song.id === ${JSON.stringify(OLD_ID)})) {
            return JSON.stringify({ ok: false, error: 'cloud verification failed' });
        }
        localStorage.setItem('aura_favorites', JSON.stringify(updated));
        localStorage.setItem('aura_favorites_revision', String(revision));
        localStorage.setItem('aura_favorites_synced_revision', String(revision));
        localStorage.removeItem('aura_favorites_dirty');
        return JSON.stringify({
            ok: true,
            index,
            revision,
            cloudCount: cloudFavorites.length,
            oldFavorite,
            replacement
        });
    })()`);

    const parsed = JSON.parse(result);
    if (!parsed.ok) throw new Error(parsed.error || 'Favorite replacement failed');
    writeFileSync('cache-favorite-replacement-backup.json', `${JSON.stringify({
        index: parsed.index,
        oldFavorite: parsed.oldFavorite,
        replacement: parsed.replacement
    }, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({
        ok: true,
        index: parsed.index,
        revision: parsed.revision,
        cloudCount: parsed.cloudCount,
        oldId: parsed.oldFavorite.id,
        newId: parsed.replacement.id,
        title: parsed.replacement.title
    }, null, 2));
    await cdpEvaluate('location.reload(); true');
}

main().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
});
