// services.js
import {
    API_BASE,
    DEFAULT_COVER,
    ICON_PLAY,
    ICON_TRASH,
    dom,
    state
} from './store.js';
import {
    appendMultilineText,
    createEmptyState,
    createSvgIcon,
    enrichTrackForLyrics,
    extractTrackInfo,
    openAccessibleModal,
    closeAccessibleModal,
    parseLRC,
    renderSkeletonList,
    showCustomDialog,
    showToast
} from './utils.js';
import { playSong } from './audio.js';

function getCoverUrl(track) {
    const rawCoverUrl = track?.cover || track?.pic || '';
    return rawCoverUrl
        ? `${API_BASE}/image?url=${encodeURIComponent(rawCoverUrl)}`
        : DEFAULT_COVER;
}

function createTrackCover(track, className = 'list-cover') {
    const image = document.createElement('img');
    image.className = className;
    image.src = getCoverUrl(track);
    image.alt = '';
    image.loading = 'lazy';
    image.decoding = 'async';
    image.addEventListener('error', () => {
        image.onerror = null;
        image.src = DEFAULT_COVER;
    }, { once: true });
    return image;
}

function createTextElement(tagName, className, text) {
    const element = document.createElement(tagName);
    element.className = className;
    element.textContent = String(text ?? '');
    return element;
}

function activatePlayer() {
    dom.pagePlayer.classList.add('expanded');
    dom.pagePlayer.setAttribute('aria-hidden', 'false');
}

async function readJsonResponse(response) {
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
        throw new Error(`服务器返回了非 JSON 数据（HTTP ${response.status}）`);
    }
    return response.json();
}

// ================= 收藏同步状态机 =================
// 旧实现每次收藏后直接发起一个不等待结果的 fetch：
// 1. 用户很快退出时，请求可能尚未完成；
// 2. 多次快速增删会并发写入，较旧请求可能最后完成并覆盖新数据；
// 3. 只检查 HTTP 状态，不检查 { success: false }，失败会被静默吞掉；
// 4. 退出登录会立刻清空本地收藏，导致未同步的数据直接丢失。
// 下面通过“本地脏标记 + 串行队列 + 退出前强制刷新 + 失败重试”解决。
const FAVORITES_DIRTY_KEY = 'aura_favorites_dirty';
const FAVORITES_REVISION_KEY = 'aura_favorites_revision';
const FAVORITES_SYNCED_REVISION_KEY = 'aura_favorites_synced_revision';

let favoritesRevision = Number(localStorage.getItem(FAVORITES_REVISION_KEY)) || 0;
let favoritesSyncQueue = Promise.resolve({ success: true, skipped: true });
let lastFavoritesSyncError = '';

function isFavoritesDirty() {
    return localStorage.getItem(FAVORITES_DIRTY_KEY) === '1';
}

function setFavoritesSyncStatus(status, message) {
    const element = document.getElementById('favorites-sync-status');
    if (!element) return;
    element.dataset.status = status;
    element.textContent = message;
}

function updateFavoritesSyncStatusForCurrentAccount() {
    if (!state.userId || state.userId === 'guest') {
        setFavoritesSyncStatus('local', '游客收藏仅保存在本机');
    } else if (isFavoritesDirty()) {
        setFavoritesSyncStatus('pending', '收藏有改动，等待同步');
    } else {
        setFavoritesSyncStatus('synced', '收藏已同步到云端');
    }
}

function persistFavoritesLocally() {
    localStorage.setItem('aura_favorites', JSON.stringify(state.favorites));
}

function markFavoritesDirty() {
    favoritesRevision += 1;
    localStorage.setItem(FAVORITES_REVISION_KEY, String(favoritesRevision));
    localStorage.setItem(FAVORITES_DIRTY_KEY, '1');
    persistFavoritesLocally();
    updateFavoritesSyncStatusForCurrentAccount();
    return favoritesRevision;
}

function markFavoritesSynced(revision) {
    localStorage.setItem(FAVORITES_SYNCED_REVISION_KEY, String(revision));
    if (revision === favoritesRevision) {
        localStorage.removeItem(FAVORITES_DIRTY_KEY);
    }
    lastFavoritesSyncError = '';
    updateFavoritesSyncStatusForCurrentAccount();
}

function acceptServerFavorites(favorites) {
    state.favorites = Array.isArray(favorites) ? favorites : [];
    persistFavoritesLocally();
    favoritesRevision += 1;
    localStorage.setItem(FAVORITES_REVISION_KEY, String(favoritesRevision));
    localStorage.setItem(FAVORITES_SYNCED_REVISION_KEY, String(favoritesRevision));
    localStorage.removeItem(FAVORITES_DIRTY_KEY);
    lastFavoritesSyncError = '';
    updateFavoritesSyncStatusForCurrentAccount();
}

async function readOptionalJsonResponse(response) {
    const text = await response.text();
    if (!text.trim()) return {};
    try {
        return JSON.parse(text);
    } catch (error) {
        throw new Error(`服务器返回的数据格式不正确（HTTP ${response.status}）`);
    }
}

function getFavoriteIdentity(favorite) {
    const url = String(favorite?.url || '').trim();
    if (url) return `url:${url}`;

    const id = String(favorite?.id || favorite?.videoId || '').trim();
    if (id) return `id:${id}`;

    const title = String(favorite?.title || '').trim();
    const artist = String(favorite?.uploader || favorite?.artist || '').trim();
    return `meta:${title}\u0000${artist}`;
}

function favoritesSnapshotsMatch(expectedFavorites, serverFavorites) {
    if (!Array.isArray(serverFavorites) || expectedFavorites.length !== serverFavorites.length) {
        return false;
    }

    const expectedIds = expectedFavorites.map(getFavoriteIdentity).sort();
    const serverIds = serverFavorites.map(getFavoriteIdentity).sort();
    return expectedIds.every((identity, index) => identity === serverIds[index]);
}

function mergeFavoritesForRecovery(localFavorites, serverFavorites) {
    const merged = Array.isArray(localFavorites) ? [...localFavorites] : [];
    const identities = new Set(merged.map(getFavoriteIdentity));

    for (const favorite of Array.isArray(serverFavorites) ? serverFavorites : []) {
        const identity = getFavoriteIdentity(favorite);
        if (identities.has(identity)) continue;
        identities.add(identity);
        merged.push(favorite);
    }

    return merged;
}

async function verifyFavoritesSnapshot({ userId, password, favorites, signal }) {
    const response = await fetch(`${API_BASE}/user/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        signal,
        body: JSON.stringify({ userId, password })
    });
    const data = await readJsonResponse(response);

    if (!response.ok || data.success !== true || data.exists !== true) {
        throw new Error(data.error || data.message || `云端收藏校验失败（HTTP ${response.status}）`);
    }
    if (!favoritesSnapshotsMatch(favorites, data.favorites)) {
        throw new Error('云端返回的收藏与本机不一致，将自动重试');
    }

    return data;
}

async function postFavoritesSnapshot({ userId, password, favorites, revision }) {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 15000);
    setFavoritesSyncStatus('syncing', '正在同步收藏…');

    try {
        const response = await fetch(`${API_BASE}/user/favorites`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            cache: 'no-store',
            keepalive: true,
            signal: controller.signal,
            body: JSON.stringify({ userId, password, favorites, revision })
        });
        const data = await readOptionalJsonResponse(response);

        if (!response.ok || data.success !== true) {
            throw new Error(data.error || data.message || `收藏同步失败（HTTP ${response.status}）`);
        }

        await verifyFavoritesSnapshot({
            userId,
            password,
            favorites,
            signal: controller.signal
        });

        // 只有服务器回读结果一致，且当前仍是同一账号和最新版本时，才清除脏标记。
        if (state.userId === userId) markFavoritesSynced(revision);
        return { success: true, data };
    } catch (error) {
        const message = error?.name === 'AbortError'
            ? '收藏同步超时，请检查网络'
            : (error?.message || '收藏同步失败');
        lastFavoritesSyncError = message;
        if (state.userId === userId) {
            localStorage.setItem(FAVORITES_DIRTY_KEY, '1');
            setFavoritesSyncStatus('error', message);
        }
        console.warn('[Aura] 收藏云同步失败', error);
        return { success: false, error: message };
    } finally {
        window.clearTimeout(timeoutId);
    }
}

export function initServices() {
    // ================= AI 推荐与 AI 聊天 =================
    async function fetchAIRecommendations() {
        const list = document.getElementById('recommend-list');
        renderSkeletonList(list, 5, { showCover: false });
        document.getElementById('refresh-rec-btn').disabled = true;

        try {
            const response = await fetch(`${API_BASE}/ai/recommend?userId=${encodeURIComponent(state.userId)}`);
            const result = await readJsonResponse(response);
            if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);

            if (result.success && Array.isArray(result.data) && result.data.length > 0) {
                state.aiRecommendData.personalized = result.data.filter(item => item.type === 'personalized');
                state.aiRecommendData.daily = result.data.filter(item => item.type === 'daily');
                state.aiRecommendData.hot = result.data.filter(item => item.type === 'hot');
                document.querySelector('.card-1')?.click();
            } else {
                list.replaceChildren(createEmptyState('暂时没有可用的推荐内容'));
            }
        } catch (error) {
            console.error('[Aura] AI 推荐拉取失败', error);
            list.replaceChildren(createEmptyState('网络连接失败，暂时无法获取推荐', 'empty-state error-state'));
        } finally {
            document.getElementById('refresh-rec-btn').disabled = false;
        }
    }

    function setCardActive(activeCard) {
        document.querySelectorAll('.rec-card').forEach(card => {
            const active = card === activeCard;
            card.classList.toggle('active', active);
            card.setAttribute('aria-pressed', String(active));
        });
    }

    document.querySelector('.card-1').addEventListener('click', function () {
        setCardActive(this);
        renderAIList(state.aiRecommendData.personalized, 'Aura 猜你喜欢');
    });
    document.querySelector('.card-2').addEventListener('click', function () {
        setCardActive(this);
        renderAIList(state.aiRecommendData.daily, '今日全网新鲜');
    });
    document.querySelector('.card-3').addEventListener('click', function () {
        setCardActive(this);
        renderAIList(state.aiRecommendData.hot, '实时热歌榜单');
    });
    document.getElementById('refresh-rec-btn').addEventListener('click', fetchAIRecommendations);
    fetchAIRecommendations();

    function addAiMessage(text, type) {
        const message = document.createElement('div');
        message.className = `message ${type}`;
        const bubble = document.createElement('div');
        bubble.className = 'bubble';
        appendMultilineText(bubble, text);
        message.appendChild(bubble);
        dom.aiChatHistory.appendChild(message);
        dom.aiChatHistory.scrollTop = dom.aiChatHistory.scrollHeight;
    }

    async function handleAiChat() {
        const message = dom.aiChatInput.value.trim();
        if (!message) return;

        addAiMessage(message, 'user');
        dom.aiChatInput.value = '';
        dom.aiSendBtn.disabled = true;

        const thinking = document.createElement('div');
        thinking.className = 'message system';
        const thinkingBubble = document.createElement('div');
        thinkingBubble.className = 'bubble thinking-bubble';
        thinkingBubble.textContent = '正在思考…';
        thinking.appendChild(thinkingBubble);
        dom.aiChatHistory.appendChild(thinking);
        dom.aiChatHistory.scrollTop = dom.aiChatHistory.scrollHeight;

        try {
            const response = await fetch(`${API_BASE}/ai/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId: state.userId, message })
            });
            const data = await readJsonResponse(response);
            thinking.remove();
            if (response.ok && data.success) addAiMessage(data.reply || '暂时没有回复内容', 'system');
            else addAiMessage(`错误：${data.error || 'AI 请求失败'}`, 'system');
        } catch (error) {
            thinking.remove();
            console.error('[Aura] AI 对话失败', error);
            addAiMessage('当前无法连接 AI 引擎，请检查网络或后端服务。', 'system');
        } finally {
            dom.aiSendBtn.disabled = false;
            dom.aiChatInput.focus();
        }
    }

    dom.aiSendBtn.addEventListener('click', handleAiChat);
    dom.aiChatInput.addEventListener('keydown', event => {
        if (event.key === 'Enter' && !event.isComposing) {
            event.preventDefault();
            handleAiChat();
        }
    });

    // ================= 搜索 =================
    async function performSearch(keyword) {
        const normalizedKeyword = String(keyword || '').trim();
        if (!normalizedKeyword) {
            showToast('请输入歌名或歌手');
            dom.searchInput.focus();
            return;
        }

        state.lastSearchQuery = normalizedKeyword;
        dom.searchResults.style.display = 'block';
        renderSkeletonList(dom.resultsList, 6);
        dom.searchBtn.disabled = true;

        try {
            const response = await fetch(`${API_BASE}/search?q=${encodeURIComponent(normalizedKeyword)}`);
            const data = await readJsonResponse(response);
            if (!response.ok) throw new Error(data.error || `搜索失败（HTTP ${response.status}）`);
            if (!Array.isArray(data)) throw new Error('搜索结果格式不正确');

            state.currentQueue = data.map(track => enrichTrackForLyrics(track, normalizedKeyword));
            dom.resultsList.replaceChildren();

            if (!state.currentQueue.length) {
                dom.resultsList.appendChild(createEmptyState('没有找到匹配的歌曲'));
                return;
            }

            const fragment = document.createDocumentFragment();
            state.currentQueue.forEach((track, index) => {
                const item = document.createElement('li');
                item.className = 'track-list-item';

                const selectButton = document.createElement('button');
                selectButton.type = 'button';
                selectButton.className = 'track-select-button';
                selectButton.setAttribute('aria-label', `播放 ${track.title || '未知歌曲'}`);
                selectButton.appendChild(createTrackCover(track));

                const info = document.createElement('span');
                info.className = 'result-info';
                info.append(
                    createTextElement('span', 'result-title', track.title || '未知歌曲'),
                    createTextElement('span', 'result-sub', `${track.uploader || '未知歌手'} · ${track.duration || '--:--'}`)
                );

                const playIcon = document.createElement('span');
                playIcon.className = 'list-play-icon';
                playIcon.appendChild(createSvgIcon(ICON_PLAY, { className: 'small-svg-icon' }));

                selectButton.append(info, playIcon);
                selectButton.addEventListener('click', () => {
                    state.currentIndex = index;
                    playSong(track);
                    activatePlayer();
                });
                item.appendChild(selectButton);
                fragment.appendChild(item);
            });
            dom.resultsList.appendChild(fragment);
        } catch (error) {
            console.error('[Aura] 搜索失败', error);
            dom.resultsList.replaceChildren(createEmptyState(error.message || '无法搜索歌曲', 'empty-state error-state'));
        } finally {
            dom.searchBtn.disabled = false;
        }
    }

    dom.searchBtn.addEventListener('click', () => performSearch(dom.searchInput.value));
    dom.searchInput.addEventListener('keydown', event => {
        if (event.key === 'Enter' && !event.isComposing) {
            event.preventDefault();
            performSearch(dom.searchInput.value);
        }
    });

    function renderAIList(dataArray, title) {
        const sectionTitle = document.getElementById('rec-section-title');
        sectionTitle.replaceChildren(document.createTextNode(title));

        const list = document.getElementById('recommend-list');
        list.replaceChildren();
        if (!Array.isArray(dataArray) || dataArray.length === 0) {
            list.appendChild(createEmptyState('该分类暂时没有推荐内容'));
            return;
        }

        const fragment = document.createDocumentFragment();
        dataArray.forEach(item => {
            const listItem = document.createElement('li');
            listItem.className = 'track-list-item';
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'track-select-button recommend-track-button';
            button.setAttribute('aria-label', `搜索 ${item.artist || ''} ${item.title || ''}`.trim());

            const info = document.createElement('span');
            info.className = 'rec-info';
            info.appendChild(createTextElement('span', 'rec-title', item.title || '未知歌曲'));

            const artistLine = document.createElement('span');
            artistLine.className = 'rec-artist';
            artistLine.appendChild(document.createTextNode(item.artist || '未知歌手'));
            const reason = document.createElement('span');
            reason.className = 'rec-tag';
            reason.textContent = item.reason || '专属推荐';
            artistLine.appendChild(reason);
            info.appendChild(artistLine);

            const playIcon = document.createElement('span');
            playIcon.className = 'list-play-icon';
            playIcon.appendChild(createSvgIcon(ICON_PLAY, { className: 'small-svg-icon' }));
            button.append(info, playIcon);

            button.addEventListener('click', () => {
                const keyword = `${item.artist || ''} ${item.title || ''}`.trim();
                dom.searchInput.value = keyword;
                document.querySelector('.top-tab-item[data-tab="tab-search"]')?.click();
                performSearch(keyword);
            });

            listItem.appendChild(button);
            fragment.appendChild(listItem);
        });
        list.appendChild(fragment);
    }

    // ================= 收藏 =================
    document.getElementById('fav-search-input').addEventListener('input', renderFavorites);
    dom.likeBtn.addEventListener('click', async () => {
        if (!state.currentTrackObj) return;
        const index = state.favorites.findIndex(favorite => favorite.url === state.currentTrackObj.url);
        if (index > -1) {
            state.favorites.splice(index, 1);
            showToast('已取消收藏');
        } else {
            state.favorites.push(state.currentTrackObj);
            showToast('已添加到收藏');
        }

        checkIfFavorited();
        if (document.getElementById('page-fav').classList.contains('active')) renderFavorites();

        const result = await saveFavorites();
        if (!result.success && state.userId !== 'guest') {
            showToast('已保存在本机，云端同步失败');
        }
    });

    // ================= 云端账号系统 =================
    const accountMenuButton = document.getElementById('account-menu-btn');
    const accountModal = document.getElementById('account-modal');
    const closeAccountButton = document.getElementById('close-account-btn');
    const currentUserIdElement = document.getElementById('current-user-id');
    const inputUserId = document.getElementById('input-user-id');
    const inputPassword = document.getElementById('input-password');
    const accountModalTitle = document.getElementById('account-modal-title');
    const authActionButton = document.getElementById('auth-action-btn');
    const toggleAuthModeButton = document.getElementById('toggle-auth-mode-btn');
    const logoutButton = document.getElementById('logout-btn');

    let authMode = 'register';

    function setAuthMode(mode) {
        authMode = mode;
        const registering = mode === 'register';
        accountModalTitle.textContent = registering ? '新账号注册' : '账号登录';
        authActionButton.textContent = registering ? '立即注册' : '立即登录';
        toggleAuthModeButton.textContent = registering ? '已有账号，直接登录' : '没有账号？去注册';
        inputPassword.autocomplete = registering ? 'new-password' : 'current-password';
    }

    function updateAccountUI() {
        const isGuest = state.userId === 'guest';
        currentUserIdElement.textContent = isGuest ? '游客（Guest）' : state.userId;
        logoutButton.hidden = isGuest;
        updateFavoritesSyncStatusForCurrentAccount();
    }

    function saveSession(userId, password) {
        state.userId = userId;
        state.password = password;

        // 持久保存登录状态：退出应用、杀掉后台或重建 WebView 后仍可恢复。
        localStorage.setItem('aura_userId', userId);
        localStorage.setItem('aura_password', password);
    }

    function clearSession() {
        state.userId = 'guest';
        state.password = '';

        // 只有用户主动退出登录时才清除持久登录状态。
        localStorage.removeItem('aura_userId');
        localStorage.removeItem('aura_password');

        // 同时清理旧版本可能残留的 sessionStorage。
        try {
            sessionStorage.removeItem('aura_userId');
            sessionStorage.removeItem('aura_password');
        } catch (error) {
            console.warn('[Aura] 清理旧会话登录数据失败', error);
        }
    }

    function setAuthBusy(busy) {
        authActionButton.disabled = busy;
        toggleAuthModeButton.disabled = busy;
        inputUserId.disabled = busy;
        inputPassword.disabled = busy;
        if (busy) authActionButton.textContent = '处理中…';
        else authActionButton.textContent = authMode === 'register' ? '立即注册' : '立即登录';
    }

    updateAccountUI();
    setAuthMode('register');

    accountMenuButton.addEventListener('click', () => {
        setAuthMode('register');
        openAccessibleModal(accountModal, inputUserId, () => closeAccessibleModal(accountModal));
    });
    closeAccountButton.addEventListener('click', () => closeAccessibleModal(accountModal));
    accountModal.addEventListener('click', event => {
        if (event.target === accountModal) closeAccessibleModal(accountModal);
    });
    toggleAuthModeButton.addEventListener('click', () => {
        setAuthMode(authMode === 'register' ? 'login' : 'register');
        inputUserId.focus();
    });

    authActionButton.addEventListener('click', async () => {
        const newUserId = inputUserId.value.trim();
        const newPassword = inputPassword.value;

        if (!newUserId) {
            await showCustomDialog({ message: '请输入账号名' });
            inputUserId.focus();
            return;
        }
        if (!newPassword) {
            await showCustomDialog({ message: '请输入密码' });
            inputPassword.focus();
            return;
        }
        if (newUserId === state.userId) {
            await showCustomDialog({ message: '当前已经登录该账号' });
            return;
        }

        setAuthBusy(true);
        try {
            const response = await fetch(`${API_BASE}/user/auth`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId: newUserId, password: newPassword })
            });
            const data = await readJsonResponse(response);
            if (!response.ok || !data.success) {
                await showCustomDialog({ message: data.error || '验证失败，请重试' });
                return;
            }

            const exists = Boolean(data.exists);
            const serverFavorites = Array.isArray(data.favorites) ? data.favorites : [];

            if (authMode === 'register') {
                if (exists) {
                    await showCustomDialog({
                        title: '注册失败',
                        message: `账号「${newUserId}」已被占用，请更换账号名。`
                    });
                    return;
                }

                const registerChoice = await showCustomDialog({
                    title: '新账号注册',
                    message: `即将注册账号「${newUserId}」。\n\n本机当前有 ${state.favorites.length} 首收藏歌曲，请选择处理方式。`,
                    buttons: [
                        { text: '迁移当前收藏', type: 'primary', resolveValue: 'migrate' },
                        { text: '创建空收藏', type: 'secondary', resolveValue: 'fresh' }
                    ]
                });

                if (!registerChoice) return;
                saveSession(newUserId, newPassword);
                if (registerChoice === 'fresh') state.favorites = [];
                const initialSync = await saveFavorites();
                if (!initialSync.success) {
                    await showCustomDialog({
                        title: '注册成功，但收藏未同步',
                        message: `${initialSync.error || '网络异常'}。登录状态已保存，收藏会在网络恢复后自动重试。`
                    });
                } else {
                    await showCustomDialog({
                        title: '注册成功',
                        message: registerChoice === 'migrate'
                            ? `已注册并迁移收藏。欢迎你，${newUserId}！`
                            : `已创建新的音乐空间。欢迎你，${newUserId}！`
                    });
                }
                finishLoginFlow();
                return;
            }

            if (!exists) {
                await showCustomDialog({
                    title: '登录失败',
                    message: `没有找到账号「${newUserId}」，请检查账号名或先注册。`
                });
                return;
            }

            const confirmed = await showCustomDialog({
                title: '账号登录',
                message: `验证通过。登录后将使用云端保存的 ${serverFavorites.length} 首收藏覆盖本机数据。`,
                buttons: [{ text: '确认登录', type: 'primary', resolveValue: true }]
            });
            if (!confirmed) return;

            saveSession(newUserId, newPassword);
            acceptServerFavorites(serverFavorites);
            await showCustomDialog({ message: `欢迎回来，${newUserId}！收藏数据已同步。` });
            finishLoginFlow();
        } catch (error) {
            console.error('[Aura] 账号操作失败', error);
            await showCustomDialog({ message: '网络连接错误，请检查后端服务' });
        } finally {
            setAuthBusy(false);
        }
    });

    function resetAiConversation() {
        dom.aiChatHistory.replaceChildren();
        const message = document.createElement('div');
        message.className = 'message system';
        const bubble = document.createElement('div');
        bubble.className = 'bubble';
        bubble.textContent = '你好！我是 Aura 专属 AI 助手。告诉我你想听什么样的音乐。';
        message.appendChild(bubble);
        dom.aiChatHistory.appendChild(message);
    }

    function finishLoginFlow() {
        renderFavorites();
        checkIfFavorited();
        updateAccountUI();
        inputUserId.value = '';
        inputPassword.value = '';
        resetAiConversation();
        fetchAIRecommendations();
        closeAccessibleModal(accountModal);
    }

    logoutButton.addEventListener('click', async () => {
        if (state.userId === 'guest') return;

        const confirmed = await showCustomDialog({
            title: '退出确认',
            message: `退出前会先确认最新收藏已经同步到账号「${state.userId}」。`,
            buttons: [
                { text: '同步并退出', type: 'primary', resolveValue: 'sync' },
                { text: '取消', type: 'secondary', resolveValue: null }
            ]
        });
        if (confirmed !== 'sync') return;

        logoutButton.disabled = true;
        let syncResult = await flushFavoritesSync();

        if (!syncResult.success) {
            const choice = await showCustomDialog({
                title: '收藏尚未同步',
                message: `${syncResult.error || lastFavoritesSyncError || '网络异常'}。

现在退出会清空本机收藏，重新登录后只能看到云端旧数据。`,
                buttons: [
                    { text: '重新同步', type: 'primary', resolveValue: 'retry' },
                    { text: '仍然退出', type: 'secondary', resolveValue: 'force' },
                    { text: '取消退出', type: 'secondary', resolveValue: null }
                ]
            });

            if (choice === 'retry') {
                syncResult = await flushFavoritesSync({ force: true });
                if (!syncResult.success) {
                    await showCustomDialog({
                        title: '同步仍然失败',
                        message: `${syncResult.error || '网络异常'}。为避免丢失收藏，本次已取消退出。`
                    });
                    logoutButton.disabled = false;
                    return;
                }
            } else if (choice !== 'force') {
                logoutButton.disabled = false;
                return;
            }
        }

        clearSession();
        state.favorites = [];
        localStorage.setItem('aura_favorites', '[]');
        localStorage.removeItem(FAVORITES_DIRTY_KEY);
        renderFavorites();
        checkIfFavorited();
        updateAccountUI();
        resetAiConversation();
        fetchAIRecommendations();
        logoutButton.disabled = false;
        await showCustomDialog({ message: '已退出登录，当前为游客模式。' });
        closeAccessibleModal(accountModal);
    });

    let favoritesRetryInFlight = false;
    const retryPendingFavorites = async () => {
        if (favoritesRetryInFlight || state.userId === 'guest' || !isFavoritesDirty()) return;
        favoritesRetryInFlight = true;
        try {
            const result = await flushFavoritesSync({ force: true });
            if (!result.success) setFavoritesSyncStatus('error', result.error || '收藏同步失败');
        } finally {
            favoritesRetryInFlight = false;
        }
    };

    const recoverySyncKey = `aura_favorites_full_recovery_v1:${encodeURIComponent(state.userId)}`;
    const recoverHistoricalFavoritesOnce = async () => {
        if (state.userId === 'guest' || !state.password || localStorage.getItem(recoverySyncKey) === '1') {
            return;
        }

        setFavoritesSyncStatus('syncing', '正在补传手机收藏…');
        try {
            const response = await fetch(`${API_BASE}/user/auth`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                cache: 'no-store',
                body: JSON.stringify({ userId: state.userId, password: state.password })
            });
            const data = await readJsonResponse(response);
            if (!response.ok || data.success !== true || data.exists !== true) {
                throw new Error(data.error || data.message || '读取云端收藏失败');
            }

            state.favorites = mergeFavoritesForRecovery(state.favorites, data.favorites);
            persistFavoritesLocally();
            renderFavorites();
            checkIfFavorited();

            const result = await saveFavorites();
            if (!result.success) throw new Error(result.error || '手机收藏补传失败');

            localStorage.setItem(recoverySyncKey, '1');
            console.info(`[AuraSync] full recovery committed user=${state.userId} count=${state.favorites.length}`);
        } catch (error) {
            const message = error?.message || '手机收藏补传失败';
            localStorage.setItem(FAVORITES_DIRTY_KEY, '1');
            setFavoritesSyncStatus('error', message);
            console.warn('[Aura] 历史收藏补传失败', error);
        }
    };

    // 上一轮离线或应用被关闭时留下的未同步收藏，在重新进入后自动补传。
    if (state.userId !== 'guest' && localStorage.getItem(recoverySyncKey) !== '1') {
        window.setTimeout(() => { void recoverHistoricalFavoritesOnce(); }, 300);
    } else if (state.userId !== 'guest' && isFavoritesDirty()) {
        window.setTimeout(() => { void retryPendingFavorites(); }, 300);
    } else {
        updateFavoritesSyncStatusForCurrentAccount();
    }

    // 网络恢复、回到前台和前台定时检查都会重试尚未确认的同步。
    window.addEventListener('online', () => { void retryPendingFavorites(); });
    window.setInterval(() => {
        if (document.visibilityState === 'visible') void retryPendingFavorites();
    }, 15000);

    // 应用切到后台或 WebView 即将销毁时，使用 keepalive 尽力完成最后一次同步。
    const flushBeforeBackground = () => {
        if (state.userId !== 'guest' && isFavoritesDirty()) {
            void saveFavorites({ markDirty: false, force: true });
        }
    };
    window.addEventListener('pagehide', flushBeforeBackground);
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') flushBeforeBackground();
        else void retryPendingFavorites();
    });
}

// ================= 收藏 =================
export async function saveFavorites({ markDirty = true, force = false } = {}) {
    const revision = markDirty ? markFavoritesDirty() : favoritesRevision;

    if (!state.userId || state.userId === 'guest' || !state.password) {
        persistFavoritesLocally();
        updateFavoritesSyncStatusForCurrentAccount();
        return { success: true, localOnly: true };
    }

    if (!force && !isFavoritesDirty()) {
        return { success: true, skipped: true };
    }

    // 必须在入队时复制快照，避免后续修改 state.favorites 改变已排队请求的数据。
    const snapshot = JSON.parse(JSON.stringify(state.favorites));
    const credentials = {
        userId: state.userId,
        password: state.password,
        favorites: snapshot,
        revision
    };

    const operation = favoritesSyncQueue
        .catch(() => ({ success: false }))
        .then(() => postFavoritesSnapshot(credentials));

    // 队列本身永远保持可继续执行，单次失败不会阻塞后续更新。
    favoritesSyncQueue = operation.catch(error => ({
        success: false,
        error: error?.message || '收藏同步失败'
    }));

    return operation;
}

export async function flushFavoritesSync({ force = false } = {}) {
    // 先等待已经排队的同步完成。
    await favoritesSyncQueue.catch(() => {});

    if (!state.userId || state.userId === 'guest' || !state.password) {
        return { success: true, localOnly: true };
    }

    if (!force && !isFavoritesDirty()) {
        updateFavoritesSyncStatusForCurrentAccount();
        return { success: true, skipped: true };
    }

    return saveFavorites({ markDirty: false, force: true });
}

export function checkIfFavorited() {
    const liked = Boolean(
        state.currentTrackObj
        && state.favorites.some(favorite => favorite.url === state.currentTrackObj.url)
    );
    dom.likeBtn.classList.toggle('liked', liked);
    dom.likeBtn.setAttribute('aria-pressed', String(liked));
    dom.likeBtn.setAttribute('aria-label', liked ? '取消收藏' : '添加到收藏夹');
    dom.likeBtn.title = liked ? '取消收藏' : '添加到收藏夹';
}

export function renderFavorites() {
    const query = (document.getElementById('fav-search-input').value || '').trim().toLowerCase();
    dom.favList.replaceChildren();

    if (!state.favorites.length) {
        dom.favList.appendChild(createEmptyState('暂无收藏歌曲'));
        return;
    }

    const filtered = state.favorites.filter(track => {
        const title = String(track.title || '').toLowerCase();
        const uploader = String(track.uploader || track.artist || '').toLowerCase();
        return title.includes(query) || uploader.includes(query);
    });

    if (!filtered.length) {
        dom.favList.appendChild(createEmptyState('没有找到匹配的收藏歌曲'));
        return;
    }

    const fragment = document.createDocumentFragment();
    filtered.forEach(track => {
        const originalIndex = state.favorites.indexOf(track);
        const listItem = document.createElement('li');
        listItem.className = 'track-list-item favorite-item';

        const playButton = document.createElement('button');
        playButton.type = 'button';
        playButton.className = 'track-select-button';
        playButton.setAttribute('aria-label', `播放 ${track.title || '未知歌曲'}`);
        playButton.appendChild(createTrackCover(track));

        const info = document.createElement('span');
        info.className = 'fav-info';
        info.append(
            createTextElement('span', 'fav-title', track.title || '未知歌曲'),
            createTextElement('span', 'fav-sub', `${track.uploader || track.artist || '未知歌手'} · ${track.duration || '--:--'}`)
        );
        playButton.appendChild(info);
        playButton.addEventListener('click', () => {
            state.currentQueue = [...state.favorites];
            state.currentIndex = originalIndex;
            playSong(track);
            activatePlayer();
        });

        const deleteButton = document.createElement('button');
        deleteButton.type = 'button';
        deleteButton.className = 'fav-del-btn icon-only-button';
        deleteButton.setAttribute('aria-label', `删除收藏 ${track.title || '未知歌曲'}`);
        deleteButton.title = '删除收藏';
        deleteButton.appendChild(createSvgIcon(ICON_TRASH, { className: 'small-svg-icon' }));
        deleteButton.addEventListener('click', async event => {
            event.stopPropagation();
            state.favorites.splice(originalIndex, 1);
            renderFavorites();
            checkIfFavorited();
            showToast('已从收藏中删除');
            const result = await saveFavorites();
            if (!result.success && state.userId !== 'guest') {
                showToast('已保存在本机，云端同步失败');
            }
        });

        listItem.append(playButton, deleteButton);
        fragment.appendChild(listItem);
    });
    dom.favList.appendChild(fragment);
}

// ================= 歌词 =================
function setLyricsMessage(lines, error = false) {
    const fragment = document.createDocumentFragment();
    const normalizedLines = Array.isArray(lines) ? lines : [lines];
    normalizedLines.forEach((line, index) => {
        const paragraph = document.createElement('p');
        paragraph.className = `lyric-line${error && index === 0 ? ' lyric-message-error' : ''}`;
        paragraph.textContent = String(line || '');
        fragment.appendChild(paragraph);
    });
    state.lyricsData = [];
    state.lyricNodes = [];
    state.currentLyricIndex = -1;
    dom.lyricsContainer.replaceChildren(fragment);
}

export async function loadRealLyrics(trackObject, requestId) {
    if (!trackObject) return;
    const info = extractTrackInfo(trackObject);
    const cacheKey = `${info.artist}|${info.title}|${trackObject.url || ''}`;

    if (state.lyricsCache.has(cacheKey)) {
        if (requestId !== state.currentLyricsRequestId) return;
        const cachedPayload = state.lyricsCache.get(cacheKey);
        state.lyricsCache.delete(cacheKey);
        state.lyricsCache.set(cacheKey, cachedPayload);
        persistLyricsCache();
        renderLyricsFromData(cachedPayload);
        return;
    }

    try {
        const duration = trackObject.durationSeconds || trackObject.duration || '';
        const directVideoId = String(trackObject.id || trackObject.videoId || '').trim();
        let videoId = /^[A-Za-z0-9_-]{11}$/.test(directVideoId) ? directVideoId : '';
        if (!videoId) {
            try {
                const sourceUrl = new URL(String(trackObject.url || ''));
                const pathParts = sourceUrl.pathname.split('/').filter(Boolean);
                videoId = sourceUrl.hostname.endsWith('youtu.be')
                    ? (pathParts[0] || '')
                    : (sourceUrl.searchParams.get('v') || pathParts.find(part => /^[A-Za-z0-9_-]{11}$/.test(part)) || '');
            } catch {
                videoId = '';
            }
        }
        const params = new URLSearchParams({
            q: `${info.artist} ${info.title}`.trim(),
            title: info.title,
            artist: info.artist,
            videoTitle: info.videoTitle,
            videoId,
            duration: String(duration || '')
        });

        const response = await fetch(`${API_BASE}/lyrics?${params.toString()}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (requestId !== state.currentLyricsRequestId) return;

        if (data?.lyrics) {
            const payload = { lyrics: String(data.lyrics || '') };
            state.lyricsCache.set(cacheKey, payload);
            while (state.lyricsCache.size > 100) {
                const firstKey = state.lyricsCache.keys().next().value;
                state.lyricsCache.delete(firstKey);
            }
            persistLyricsCache();
            renderLyricsFromData(payload);
        } else {
            setLyricsMessage('暂未找到歌词');
        }
    } catch (error) {
        if (requestId !== state.currentLyricsRequestId) return;
        console.warn('[Aura] 歌词获取失败', error);
        if (navigator.onLine === false) {
            setLyricsMessage(['离线模式', '本地没有这首歌的歌词缓存'], true);
        } else {
            setLyricsMessage(['歌词加载失败', '网络连接正常，请稍后重试'], true);
        }
    }
}

function persistLyricsCache() {
    try {
        localStorage.setItem('aura_offline_lyrics', JSON.stringify(Object.fromEntries(state.lyricsCache)));
    } catch (error) {
        console.warn('[Aura] 歌词缓存写入失败', error);
    }
}

export function renderLyricsFromData(data) {
    const lyricText = String(data.lyrics || '');
    if (!lyricText.trim()) {
        setLyricsMessage('暂未找到歌词');
        return;
    }

    const parsed = parseLRC(lyricText);
    state.currentLyricIndex = -1;
    state.lyricNodes = [];
    dom.lyricsContainer.replaceChildren();

    if (parsed.length > 0) {
        state.lyricsData = parsed;
        const fragment = document.createDocumentFragment();

        parsed.forEach(line => {
            const paragraph = document.createElement('p');
            paragraph.className = 'lyric-line';
            paragraph.textContent = line.text;

            paragraph.addEventListener('click', event => {
                event.preventDefault();
                event.stopPropagation();
                if (!state.currentAudioDuration) return;

                const targetTime = Math.max(
                    0,
                    Math.min(line.time - state.lyricOffset, state.currentAudioDuration - 0.2)
                );
                state.isSeekingByLyric = true;

                if (window.AndroidNative?.seekAudio) {
                    window.AndroidNative.seekAudio(Math.floor(targetTime * 1000));
                    window.AndroidNative.resumeAudio?.();
                } else if (dom.webAudio) {
                    dom.webAudio.currentTime = targetTime;
                    dom.webAudio.play().catch(() => {});
                }
                window.setTimeout(() => { state.isSeekingByLyric = false; }, 500);
            });

            state.lyricNodes.push(paragraph);
            fragment.appendChild(paragraph);
        });
        dom.lyricsContainer.appendChild(fragment);
        return;
    }

    state.lyricsData = [];
    const textLines = lyricText
        .replace(/<[^>]+>/g, '')
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean);

    if (!textLines.length) {
        setLyricsMessage('暂未找到歌词');
        return;
    }

    const fragment = document.createDocumentFragment();
    textLines.forEach(text => {
        const paragraph = document.createElement('p');
        paragraph.className = 'lyric-line static-lyric-line';
        paragraph.textContent = text;
        fragment.appendChild(paragraph);
    });
    dom.lyricsContainer.appendChild(fragment);
}
