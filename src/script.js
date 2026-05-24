// =========================
// Aura Mobile App Core
// =========================
const API_BASE = 'http://114.132.251.94:3000/api';

// 获取 DOM 元素
const chatInput = document.getElementById('chat-input');
const sendBtn = document.getElementById('send-btn');
const chatHistory = document.getElementById('chat-history');
const searchResults = document.getElementById('search-results');
const resultsList = document.getElementById('results-list');
const audioPlayer = document.getElementById('audio-player');
const playBtn = document.getElementById('play-btn');
const recordDisc = document.getElementById('record-disc');
const recordCover = document.getElementById('record-cover');
const songTitle = document.getElementById('song-title');
const songArtist = document.getElementById('song-artist');
const progressBar = document.getElementById('progress-bar');
const progressCurrent = document.getElementById('progress-current');
const currentTimeEl = document.getElementById('current-time');
const durationEl = document.getElementById('duration');
const lyricsContainer = document.getElementById('lyrics-container');
const likeBtn = document.getElementById('like-btn');
const favList = document.getElementById('fav-list');
const offsetDisplay = document.getElementById('offset-display');

// 状态变量
let lyricOffset = 0;
let currentQueue = [];
let currentIndex = 0;
let lyricsData = [];
let lastSearchQuery = '';
let currentTrackObj = null;
let favorites = JSON.parse(localStorage.getItem('aura_favorites')) || [];
let currentLyricsRequestId = 0;
let currentPlayRequestId = 0;
let lyricsAbortController = null;
let isSeekingByLyric = false;
const lyricsCache = new Map();

// ================= 底部导航栏切换逻辑 =================
const navItems = document.querySelectorAll('.nav-item');
const pages = document.querySelectorAll('.page-view');

function switchTab(targetId) {
    navItems.forEach(nav => nav.classList.remove('active'));
    pages.forEach(page => page.classList.remove('active'));
    
    document.querySelector(`[data-target="${targetId}"]`).classList.add('active');
    document.getElementById(targetId).classList.add('active');
    
    if(targetId === 'page-fav') renderFavorites();
}

navItems.forEach(item => {
    item.addEventListener('click', () => switchTab(item.dataset.target));
});

function jumpToPlayer() {
    switchTab('page-player');
}

// ================= 锁屏控制 & 后台播放 (Media Session API) =================
function updateLockScreenControls(track) {
    if ('mediaSession' in navigator) {
        // 更新锁屏显示的标题、歌手和封面图
        navigator.mediaSession.metadata = new MediaMetadata({
            title: track.title,
            artist: track.uploader || track.artist || 'Aura 音乐',
            album: 'Aura',
            artwork: [
                { src: track.cover || 'https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?w=300&q=80', sizes: '512x512', type: 'image/jpeg' }
            ]
        });

        // 绑定锁屏界面的原生按键
        navigator.mediaSession.setActionHandler('play', async () => {
            await audioPlayer.play();
            updatePlayState(true);
        });
        navigator.mediaSession.setActionHandler('pause', () => {
            audioPlayer.pause();
            updatePlayState(false);
        });
        navigator.mediaSession.setActionHandler('previoustrack', () => {
            document.getElementById('prev-btn').click();
        });
        navigator.mediaSession.setActionHandler('nexttrack', () => {
            document.getElementById('next-btn').click();
        });
        navigator.mediaSession.setActionHandler('seekto', (details) => {
            if (details.fastSeek && 'fastSeek' in audioPlayer) {
              audioPlayer.fastSeek(details.seekTime);
            } else {
              audioPlayer.currentTime = details.seekTime;
            }
        });
    }
}

// ================= 工具函数 =================
function saveFavorites() { localStorage.setItem('aura_favorites', JSON.stringify(favorites)); }

// (保留了你之前的文本清理和歌词解析逻辑)
function cleanText(text = '') { return String(text).replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/【[^】]*】/g, ' ').replace(/\[[^\]]*]/g, ' ').replace(/\([^)]*\)/g, ' ').replace(/（[^）]*）/g, ' ').replace(/\b(official|music|video|mv|lyrics?|lyric|audio|visualizer|live|cover|remix|version|full|hd|4k|1080p|pinyin|karaoke|instrumental|prod\.?|feat\.?|ft\.?)\b/gi, ' ').replace(/官方|歌词版|动态歌词|动态拼音歌词|拼音歌词|拼音|中字|字幕|完整版|高清|现场|现场版|纯享版|无损|伴奏|翻唱|官方版|新歌|音频/gi, ' ').replace(/[＿_｜|/\\·•●★☆♪♫♬♩~～×]/g, ' ').replace(/\s*-\s*/g, ' - ').replace(/\s+/g, ' ').trim(); }
function cleanArtistName(text = '') { return cleanText(text).replace(/- Topic/gi, '').replace(/VEVO|Official|Records|Music|Studio|频道|頻道|Channel|Artist|歌手|工作室|音乐/gi, '').replace(/\s+/g, ' ').trim(); }
function extractTrackInfo(track = {}) {
    const rawTitle = String(track.title || '');
    const uploader = String(track.uploader || '');
    if (track.lyricTitle || track.lyricArtist) return { title: cleanText(track.lyricTitle || track.title || ''), artist: cleanArtistName(track.lyricArtist || track.uploader || ''), videoTitle: rawTitle, uploader };
    let artist = '', title = '';
    let m = rawTitle.match(/^\s*([^《「『【\[\(（]{1,50})\s*[《「『【]\s*([^》」』】]{1,80})\s*[》」』】]/);
    if (m) { artist = cleanArtistName(m[1]); title = cleanText(m[2]); }
    if (!title) { const cleaned = cleanText(rawTitle); const parts = cleaned.split(/\s+/).filter(Boolean); if (parts.length >= 2) { artist = artist || cleanArtistName(parts[0]); title = cleanText(parts.slice(1).join(' ')); } else { title = cleaned; } }
    if (!artist) artist = cleanArtistName(uploader);
    return { title: title || cleanText(rawTitle), artist, videoTitle: rawTitle, uploader };
}
function enrichTrackForLyrics(track, searchKeyword = '') { const info = extractTrackInfo(track); return { ...track, searchKeyword: searchKeyword || track.searchKeyword || '', lyricTitle: info.title, lyricArtist: info.artist, videoTitle: info.videoTitle }; }

function parseLRC(lrcString) {
    const lines = String(lrcString || '').replace(/\r/g, '').split('\n');
    const parsed = [];
    for (const line of lines) {
        const timeTags = [...line.matchAll(/\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?]/g)];
        if (!timeTags.length) continue;
        const lyricText = line.replace(/\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?]/g, '').trim();
        if (!lyricText) continue;
        for (const tag of timeTags) {
            const ms = parseInt((tag[3] || '0').padEnd(3, '0').slice(0, 3), 10);
            parsed.push({ time: parseInt(tag[1], 10) * 60 + parseInt(tag[2], 10) + ms / 1000, text: lyricText });
        }
    }
    return parsed.sort((a, b) => a.time - b.time);
}

function addMessage(text, type) {
    const msgDiv = document.createElement('div');
    msgDiv.className = `message ${type}`;
    msgDiv.innerHTML = `<div class="bubble">${text}</div>`;
    chatHistory.appendChild(msgDiv);
    chatHistory.scrollTop = chatHistory.scrollHeight;
}

// ================= 播放与检索核心 =================
async function handleSend() {
    const keyword = chatInput.value.trim();
    if (!keyword) return;
    lastSearchQuery = keyword;
    addMessage(keyword, 'user');
    chatInput.value = '';
    searchResults.style.display = 'none';
    addMessage(`正在搜索：${keyword}`, 'system');
    await fetchSearch(keyword);
}

sendBtn.addEventListener('click', handleSend);
chatInput.addEventListener('keypress', e => { if (e.key === 'Enter') handleSend(); });

async function fetchSearch(keyword) {
    try {
        const res = await fetch(`${API_BASE}/search?q=${encodeURIComponent(keyword)}`);
        const data = await res.json();
        if (res.status !== 200) { addMessage(`❌ ${data.error || '搜索失败'}`, 'system'); return; }
        currentQueue = data.map(track => enrichTrackForLyrics(track, keyword));
        resultsList.innerHTML = '';
        currentQueue.forEach((track, index) => {
            const li = document.createElement('li');
            li.innerHTML = `<div class="result-info"><div class="result-title">${track.title}</div><div class="result-sub">${track.uploader} | ${track.duration}</div></div><div class="play-tag">播放</div>`;
            li.addEventListener('click', () => {
                currentIndex = index;
                playSong(track);
                jumpToPlayer(); // 手机端点歌后自动跳转到播放页面
            });
            resultsList.appendChild(li);
        });
        addMessage('检索成功', 'system');
        searchResults.style.display = 'block';
    } catch (err) { addMessage('❌ 后端连接失败', 'system'); }
}

async function playSong(track) {
    if (!track) return;
    const playId = ++currentPlayRequestId;
    let playableTrack = enrichTrackForLyrics(track, track.searchKeyword || '');
    currentTrackObj = playableTrack;
    
    songTitle.innerText = playableTrack.title;
    songArtist.innerText = playableTrack.uploader;
    recordCover.src = playableTrack.cover || 'https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?w=300&q=80';
    checkIfFavorited();
    
    // 注册锁屏控制
    updateLockScreenControls(playableTrack);

    if (lyricsAbortController) { lyricsAbortController.abort(); lyricsAbortController = null; }
    lyricsData = []; lyricsContainer.innerHTML = '<p class="lyric-line">🎵 正在加载歌词...</p>';
    
    audioPlayer.pause();
    audioPlayer.removeAttribute('src');
    audioPlayer.load();
    updatePlayState(false);
    lyricOffset = 0; updateOffsetDisplay();

    try {
        audioPlayer.src = `${API_BASE}/stream?url=${encodeURIComponent(playableTrack.url)}&t=${Date.now()}`;
        audioPlayer.load();
        loadRealLyrics(playableTrack, ++currentLyricsRequestId);
        await audioPlayer.play();
        if (playId === currentPlayRequestId) updatePlayState(true);
    } catch (err) {
        addMessage('❌ 播放失败', 'system');
        updatePlayState(false);
    }
}

// ================= 歌词逻辑 =================
async function loadRealLyrics(trackObj, requestId) {
    const info = extractTrackInfo(trackObj);
    const params = new URLSearchParams({ q: `${info.artist} ${info.title}`.trim(), title: info.title, artist: info.artist, videoTitle: info.videoTitle, videoUrl: trackObj.url || '', duration: String(trackObj.durationSeconds || trackObj.duration || '') });
    
    try {
        lyricsAbortController = new AbortController();
        const res = await fetch(`${API_BASE}/lyrics?${params.toString()}`, { signal: lyricsAbortController.signal });
        const data = await res.json();
        if (requestId !== currentLyricsRequestId) return;

        if (data?.lyrics) {
            const parsed = parseLRC(data.lyrics);
            if (parsed.length > 0) {
                lyricsData = parsed;
                lyricsContainer.innerHTML = '';
                lyricsData.forEach((line, index) => {
                    const p = document.createElement('p');
                    p.className = 'lyric-line'; p.innerText = line.text; p.dataset.time = String(line.time);
                    p.addEventListener('click', async () => {
                        audioPlayer.currentTime = line.time + lyricOffset;
                        await audioPlayer.play(); updatePlayState(true);
                    });
                    lyricsContainer.appendChild(p);
                });
            } else {
                lyricsContainer.innerHTML = '<p class="lyric-line" style="color:#e74c3c;">（当前为纯文本歌词）</p>';
                String(data.lyrics).split('\n').forEach(line => {
                    if(line.trim()) lyricsContainer.innerHTML += `<p class="lyric-line">${line.trim()}</p>`;
                });
            }
        } else {
            lyricsContainer.innerHTML = '<p class="lyric-line">🎵 暂未找到歌词</p>';
        }
    } catch (err) {
        if (requestId === currentLyricsRequestId) lyricsContainer.innerHTML = '<p class="lyric-line">🎵 歌词加载失败/超时</p>';
    }
}

// ================= 控件与状态 =================
function updatePlayState(isPlaying) {
    playBtn.innerText = isPlaying ? '⏸' : '▶';
    isPlaying ? recordDisc.classList.add('playing') : recordDisc.classList.remove('playing');
    
    // 更新手机锁屏的播放状态
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';
}

playBtn.addEventListener('click', async () => {
    if (!audioPlayer.src) return;
    audioPlayer.paused ? await audioPlayer.play() : audioPlayer.pause();
    updatePlayState(!audioPlayer.paused);
});

document.getElementById('prev-btn').addEventListener('click', () => { if (currentIndex > 0) playSong(currentQueue[--currentIndex]); });
document.getElementById('next-btn').addEventListener('click', () => { if (currentIndex < currentQueue.length - 1) playSong(currentQueue[++currentIndex]); });
audioPlayer.addEventListener('ended', () => document.getElementById('next-btn').click());

function formatTime(seconds) {
    if (isNaN(seconds)) return '00:00';
    const m = Math.floor(seconds / 60), s = Math.floor(seconds % 60);
    return `${m < 10 ? '0' + m : m}:${s < 10 ? '0' + s : s}`;
}

audioPlayer.addEventListener('timeupdate', () => {
    if (!audioPlayer.duration) return;
    progressCurrent.style.width = (audioPlayer.currentTime / audioPlayer.duration) * 100 + '%';
    currentTimeEl.innerText = formatTime(audioPlayer.currentTime);
    durationEl.innerText = formatTime(audioPlayer.duration);
    
    // 歌词滚动
    if (lyricsData.length > 0) {
        let activeIndex = -1;
        for (let i = 0; i < lyricsData.length; i++) { if (audioPlayer.currentTime >= lyricsData[i].time + lyricOffset) activeIndex = i; }
        if (activeIndex !== -1) {
            const oldActive = document.querySelector('.lyric-line.active');
            const newActive = lyricsContainer.querySelectorAll('.lyric-line')[activeIndex];
            if (oldActive !== newActive) {
                if (oldActive) oldActive.classList.remove('active');
                if (newActive) {
                    newActive.classList.add('active');
                    newActive.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }
            }
        }
    }
});

progressBar.addEventListener('click', function (e) { if (audioPlayer.duration) audioPlayer.currentTime = (e.offsetX / this.clientWidth) * audioPlayer.duration; });

document.getElementById('offset-minus').addEventListener('click', () => { lyricOffset -= 0.5; updateOffsetDisplay(); });
document.getElementById('offset-plus').addEventListener('click', () => { lyricOffset += 0.5; updateOffsetDisplay(); });
function updateOffsetDisplay() { offsetDisplay.innerText = `补偿: ${lyricOffset.toFixed(1)}s`; }

// ================= 收藏夹 =================
function checkIfFavorited() {
    if (!currentTrackObj) { likeBtn.style.display = 'none'; return; }
    likeBtn.style.display = 'inline-block';
    const isFav = favorites.some(f => f.url === currentTrackObj.url);
    isFav ? (likeBtn.innerText = '❤️', likeBtn.classList.add('liked')) : (likeBtn.innerText = '🤍', likeBtn.classList.remove('liked'));
}

likeBtn.addEventListener('click', () => {
    if (!currentTrackObj) return;
    const index = favorites.findIndex(f => f.url === currentTrackObj.url);
    index > -1 ? favorites.splice(index, 1) : favorites.push(currentTrackObj);
    saveFavorites(); checkIfFavorited();
    if (document.getElementById('page-fav').classList.contains('active')) renderFavorites();
});

function renderFavorites() {
    favList.innerHTML = '';
    if (favorites.length === 0) { favList.innerHTML = '<p style="text-align:center;color:#bdc3c7;margin-top:40px;">暂无收藏 ❤️</p>'; return; }
    favorites.forEach((track, i) => {
        const li = document.createElement('li');
        li.innerHTML = `<div class="fav-info"><div class="fav-title">${track.title}</div><div class="fav-sub">${track.uploader}</div></div><button class="fav-del-btn">✖</button>`;
        li.querySelector('.fav-info').addEventListener('click', () => { playSong(track); jumpToPlayer(); });
        li.querySelector('.fav-del-btn').addEventListener('click', e => { e.stopPropagation(); favorites.splice(i, 1); saveFavorites(); renderFavorites(); checkIfFavorited(); });
        favList.appendChild(li);
    });
}