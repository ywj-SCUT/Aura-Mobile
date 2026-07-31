// store.js
export const API_BASE = 'http://47.77.230.218:3000/api';
export const DEFAULT_COVER = './default-cover.svg';
// ================= 图标路径（统一 24×24 SVG） =================
export const ICON_PLAY = '<path d="M8 5v14l11-7z" fill="currentColor"/>';
export const ICON_PAUSE = '<path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" fill="currentColor"/>';
export const ICON_PREV = '<path d="M6 6h2v12H6zm3.5 6 8.5 6V6z" fill="currentColor"/>';
export const ICON_NEXT = '<path d="m6 18 8.5-6L6 6v12zM16 6v12h2V6h-2z" fill="currentColor"/>';
export const ICON_REFRESH = '<path d="M17.65 6.35A7.95 7.95 0 0 0 12 4a8 8 0 1 0 7.9 9.2h-2.05A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h8V3z" fill="currentColor"/>';
export const ICON_TRASH = '<path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zm3.46-7.12 1.41-1.41L12 11.59l1.12-1.12 1.41 1.41L13.41 13l1.12 1.12-1.41 1.41L12 14.41l-1.12 1.12-1.41-1.41L10.59 13l-1.13-1.12zM15.5 4l-1-1h-5l-1 1H5v2h14V4z" fill="currentColor"/>';
export const ICON_SEQ = '<path d="M7 7h10.59l-1.3 1.29 1.42 1.42L21.41 6l-3.7-3.71-1.42 1.42L17.59 5H7a5 5 0 0 0-5 5v1h2v-1a3 3 0 0 1 3-3zm10 10H6.41l1.3-1.29-1.42-1.42L2.59 18l3.7 3.71 1.42-1.42L6.41 19H17a5 5 0 0 0 5-5v-1h-2v1a3 3 0 0 1-3 3z" fill="currentColor"/>';
export const ICON_SHUFFLE = '<path d="M16 3h5v5h-2V6.41l-4.29 4.3-1.42-1.42L17.59 5H16V3zM4 5h5.41l9 9H21v2h-3.41l-9-9H4V5zm0 14v-2h4.59l2-2 1.41 1.41L9.41 19H4zm12 2v-2h1.59l-2.3-2.29 1.42-1.42L19 17.59V16h2v5h-5z" fill="currentColor"/>';
export const ICON_LOOP = '<path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4zm-4-2V9h-1l-2 1v1h1.5v4H13z" fill="currentColor"/>';

export const MODE_MAP = {
    sequence: { icon: ICON_SEQ, text: '列表循环' },
    loop: { icon: ICON_LOOP, text: '单曲循环' },
    shuffle: { icon: ICON_SHUFFLE, text: '随机播放' }
};

function safeParseJson(rawValue, fallback) {
    if (!rawValue) return fallback;
    try {
        const parsed = JSON.parse(rawValue);
        return parsed ?? fallback;
    } catch (error) {
        console.warn('[Aura] 本地数据解析失败，已使用默认值', error);
        return fallback;
    }
}

function clampNumber(value, min, max, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, number));
}

// 登录状态使用 localStorage 持久化。关闭应用或 WebView 后再次进入仍保持登录。
// 只有用户主动点击“退出登录”时，services.js 才会清除这些字段。
localStorage.removeItem('aura_show_translation');

// 清理旧版本遗留的会话级登录数据，避免 sessionStorage 中的过期账号干扰。
try {
    sessionStorage.removeItem('aura_userId');
    sessionStorage.removeItem('aura_password');
} catch (error) {
    console.warn('[Aura] 清理旧会话登录数据失败', error);
}

// ================= DOM 元素 =================
export const dom = {
    pagePlayer: document.getElementById('page-player'),
    searchInput: document.getElementById('search-input'),
    searchBtn: document.getElementById('search-btn'),
    searchResults: document.getElementById('search-results'),
    resultsList: document.getElementById('results-list'),
    playBtn: document.getElementById('play-btn'),
    playIconSvg: document.getElementById('play-icon-svg'),
    miniPlayIconSvg: document.getElementById('mini-play-icon-svg'),
    recordDisc: document.getElementById('record-disc'),
    albumCover: document.getElementById('album-cover'),
    recordCover: document.getElementById('record-cover'),
    playerBlurBg: document.getElementById('player-blur-bg'),
    songTitle: document.getElementById('song-title'),
    songArtist: document.getElementById('song-artist'),
    progressBar: document.getElementById('progress-bar'),
    progressCurrent: document.getElementById('progress-current'),
    currentTimeEl: document.getElementById('current-time'),
    durationEl: document.getElementById('duration'),
    lyricsContainer: document.getElementById('lyrics-container'),
    likeBtn: document.getElementById('like-btn'),
    favList: document.getElementById('fav-list'),
    offsetDisplay: document.getElementById('offset-display'),
    aiChatInput: document.getElementById('ai-chat-input'),
    aiSendBtn: document.getElementById('ai-send-btn'),
    aiChatHistory: document.getElementById('ai-chat-history'),
    modeBtn: document.getElementById('mode-btn'),
    modeIcon: document.getElementById('mode-icon'),
    queueBtn: document.getElementById('queue-btn'),
    queueDrawer: document.getElementById('queue-drawer'),
    queueBackdrop: document.getElementById('queue-backdrop'),
    closeDrawerBtn: document.getElementById('close-drawer-btn'),
    drawerList: document.getElementById('drawer-list'),
    queueCount: document.getElementById('queue-count'),
    navItems: document.querySelectorAll('.nav-item'),
    pages: document.querySelectorAll('.page-view'),
    toggleLyricBtn: document.getElementById('toggle-lyric-btn'),
    miniPlayer: document.getElementById('mini-player'),
    collapsePlayerBtn: document.getElementById('collapse-player-btn'),
    miniPlayBtn: document.getElementById('mini-play-btn'),
    miniNextBtn: document.getElementById('mini-next-btn'),
    miniPrevBtn: document.getElementById('mini-prev-btn'),
    toggleControlsBtn: document.getElementById('toggle-controls-btn'),
    webAudio: document.getElementById('web-audio'),
    toast: document.getElementById('app-toast')
};

const rawOfflineLyricsObject = safeParseJson(localStorage.getItem('aura_offline_lyrics'), {});
const offlineLyricsObject = Object.fromEntries(
    Object.entries(rawOfflineLyricsObject || {}).map(([key, value]) => [
        key,
        { lyrics: String(value?.lyrics || '') }
    ])
);
const favorites = safeParseJson(localStorage.getItem('aura_favorites'), []);

// 旧缓存中即使含有翻译字段，也会在本次启动后只保留原歌词。
try {
    localStorage.setItem('aura_offline_lyrics', JSON.stringify(offlineLyricsObject));
} catch (error) {
    console.warn('[Aura] 清理旧歌词缓存失败', error);
}

// ================= 全局可变状态 =================
export const state = {
    lyricOffset: 0,
    currentQueue: [],
    currentIndex: 0,
    lyricsData: [],
    lyricNodes: [],
    currentLyricIndex: -1,
    lastSearchQuery: '',
    currentTrackObj: null,
    favorites: Array.isArray(favorites) ? favorites : [],
    currentLyricsRequestId: 0,
    isSeekingByLyric: false,
    lyricsCache: new Map(Object.entries(offlineLyricsObject)),
    playMode: localStorage.getItem('aura_play_mode') || 'sequence',
    currentAudioDuration: 0,
    currentAudioTime: 0,
    isNativePlaying: false,
    baseFontSize: clampNumber(localStorage.getItem('aura_lyric_size'), 18, 34, 24),
    selectedTheme: localStorage.getItem('aura_theme') || 'red',
    aiRecommendData: { personalized: [], daily: [], hot: [] },
    userId: localStorage.getItem('aura_userId') || 'guest',
    password: localStorage.getItem('aura_password') || ''
};

if (!MODE_MAP[state.playMode]) state.playMode = 'sequence';
