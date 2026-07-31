// audio.js
import {
    API_BASE,
    DEFAULT_COVER,
    dom,
    state,
    ICON_PLAY,
    ICON_PAUSE,
    MODE_MAP
} from './store.js';
import { formatTime, enrichTrackForLyrics, showToast } from './utils.js';
import { loadRealLyrics, checkIfFavorited } from './services.js';

function findActiveLyricIndex(playbackTime) {
    if (!state.lyricsData.length) return -1;

    let left = 0;
    let right = state.lyricsData.length - 1;
    let answer = -1;

    while (left <= right) {
        const middle = Math.floor((left + right) / 2);
        if (state.lyricsData[middle].time <= playbackTime) {
            answer = middle;
            left = middle + 1;
        } else {
            right = middle - 1;
        }
    }

    return answer;
}

function updateProgressUi() {
    const duration = Number.isFinite(state.currentAudioDuration) ? state.currentAudioDuration : 0;
    const current = Math.min(Math.max(state.currentAudioTime, 0), duration || 0);
    const ratio = duration > 0 ? current / duration : 0;

    dom.progressCurrent.style.width = `${ratio * 100}%`;
    dom.progressBar.style.setProperty('--progress-ratio', String(ratio));
    dom.currentTimeEl.textContent = formatTime(current);
    dom.durationEl.textContent = formatTime(duration);
    dom.progressBar.setAttribute('aria-valuemax', String(Math.floor(duration)));
    dom.progressBar.setAttribute('aria-valuenow', String(Math.floor(current)));
    dom.progressBar.setAttribute('aria-valuetext', `${formatTime(current)} / ${formatTime(duration)}`);
}

function updateActiveLyric() {
    const activeIndex = findActiveLyricIndex(state.currentAudioTime + state.lyricOffset);
    if (activeIndex === state.currentLyricIndex || activeIndex < 0) return;

    const oldNode = state.lyricNodes[state.currentLyricIndex];
    const newNode = state.lyricNodes[activeIndex];
    oldNode?.classList.remove('active');
    newNode?.classList.add('active');
    state.currentLyricIndex = activeIndex;

    if (!newNode) return;
    const container = dom.lyricsContainer;
    const targetTop = newNode.offsetTop - container.clientHeight / 2 + newNode.clientHeight / 2;
    container.scrollTo({
        top: Math.max(0, targetTop),
        behavior: state.isSeekingByLyric ? 'auto' : 'smooth'
    });
}

function seekToSeconds(targetTime) {
    if (!state.currentAudioDuration) return;
    const safeTime = Math.min(Math.max(Number(targetTime) || 0, 0), state.currentAudioDuration);
    state.currentAudioTime = safeTime;
    updateProgressUi();

    if (window.AndroidNative?.seekAudio) {
        window.AndroidNative.seekAudio(Math.floor(safeTime * 1000));
    } else if (dom.webAudio) {
        dom.webAudio.currentTime = safeTime;
    }
}

function seekFromClientX(clientX) {
    const rect = dom.progressBar.getBoundingClientRect();
    if (!rect.width || !state.currentAudioDuration) return;
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    seekToSeconds(ratio * state.currentAudioDuration);
}

function updateModeUi(announce = false) {
    const mode = MODE_MAP[state.playMode] || MODE_MAP.sequence;
    dom.modeIcon.innerHTML = mode.icon;
    dom.modeBtn.title = mode.text;
    dom.modeBtn.setAttribute('aria-label', `播放模式：${mode.text}`);
    localStorage.setItem('aura_play_mode', state.playMode);
    if (announce) showToast(mode.text);
}

function updateOffsetDisplay() {
    dom.offsetDisplay.textContent = `${state.lyricOffset > 0 ? '+' : ''}${state.lyricOffset.toFixed(1)}s`;
}

export function initAudio() {
    window.AuraJS = {
        onProgress: (currentMs, durationMs) => {
            state.currentAudioTime = Math.max(0, Number(currentMs) / 1000 || 0);
            state.currentAudioDuration = Math.max(0, Number(durationMs) / 1000 || 0);
            updateProgressUi();
            updateActiveLyric();
        },
        onStateChanged: isPlaying => {
            state.isNativePlaying = Boolean(isPlaying);
            updatePlayState(state.isNativePlaying);
        },
        onEnded: () => {
            if (state.playMode === 'loop') {
                seekToSeconds(0);
                if (window.AndroidNative?.resumeAudio) window.AndroidNative.resumeAudio();
                else dom.webAudio?.play().catch(() => {});
                return;
            }
            document.getElementById('next-btn')?.click();
        },
        onError: () => {
            console.error('[Aura] 播放异常，准备尝试下一首');
            updatePlayState(false);
            showToast('播放失败，正在尝试下一首');
            window.setTimeout(() => document.getElementById('next-btn')?.click(), 1500);
        },
        nativeNext: () => document.getElementById('next-btn')?.click(),
        nativePrev: () => document.getElementById('prev-btn')?.click()
    };

    if (dom.webAudio) {
        dom.webAudio.addEventListener('timeupdate', () => {
            if (!window.AndroidNative) {
                window.AuraJS.onProgress(dom.webAudio.currentTime * 1000, dom.webAudio.duration * 1000);
            }
        });
        dom.webAudio.addEventListener('durationchange', () => {
            if (!window.AndroidNative) {
                window.AuraJS.onProgress(dom.webAudio.currentTime * 1000, dom.webAudio.duration * 1000);
            }
        });
        dom.webAudio.addEventListener('ended', () => {
            if (!window.AndroidNative) window.AuraJS.onEnded();
        });
        dom.webAudio.addEventListener('play', () => {
            if (!window.AndroidNative) window.AuraJS.onStateChanged(true);
        });
        dom.webAudio.addEventListener('pause', () => {
            if (!window.AndroidNative) window.AuraJS.onStateChanged(false);
        });
        dom.webAudio.addEventListener('error', () => {
            if (!window.AndroidNative) window.AuraJS.onError();
        });
    }

    updateModeUi(false);
    updateOffsetDisplay();
    updateProgressUi();

    dom.modeBtn.addEventListener('click', () => {
        state.playMode = state.playMode === 'sequence'
            ? 'loop'
            : state.playMode === 'loop'
                ? 'shuffle'
                : 'sequence';
        updateModeUi(true);
    });

    let draggingProgress = false;
    dom.progressBar.addEventListener('pointerdown', event => {
        if (!state.currentAudioDuration) return;
        draggingProgress = true;
        dom.progressBar.classList.add('dragging');
        dom.progressBar.setPointerCapture?.(event.pointerId);
        seekFromClientX(event.clientX);
    });
    dom.progressBar.addEventListener('pointermove', event => {
        if (draggingProgress) seekFromClientX(event.clientX);
    });
    const stopDragging = event => {
        if (!draggingProgress) return;
        draggingProgress = false;
        dom.progressBar.classList.remove('dragging');
        if (dom.progressBar.hasPointerCapture?.(event.pointerId)) {
            dom.progressBar.releasePointerCapture(event.pointerId);
        }
    };
    dom.progressBar.addEventListener('pointerup', stopDragging);
    dom.progressBar.addEventListener('pointercancel', stopDragging);
    dom.progressBar.addEventListener('keydown', event => {
        if (!state.currentAudioDuration) return;
        let target = state.currentAudioTime;
        if (event.key === 'ArrowLeft') target -= 5;
        else if (event.key === 'ArrowRight') target += 5;
        else if (event.key === 'Home') target = 0;
        else if (event.key === 'End') target = state.currentAudioDuration;
        else return;
        event.preventDefault();
        seekToSeconds(target);
    });

    document.getElementById('offset-minus').addEventListener('click', () => {
        state.lyricOffset = Math.max(-10, state.lyricOffset - 0.5);
        updateOffsetDisplay();
        updateActiveLyric();
    });
    document.getElementById('offset-plus').addEventListener('click', () => {
        state.lyricOffset = Math.min(10, state.lyricOffset + 0.5);
        updateOffsetDisplay();
        updateActiveLyric();
    });

    const togglePlay = () => {
        if (!state.currentTrackObj) {
            showToast('请先选择一首歌曲');
            return;
        }

        if (window.AndroidNative) {
            if (state.isNativePlaying) window.AndroidNative.pauseAudio?.();
            else window.AndroidNative.resumeAudio?.();
        } else if (dom.webAudio) {
            if (state.isNativePlaying) dom.webAudio.pause();
            else dom.webAudio.play().catch(error => {
                console.error('[Aura] 网页播放失败', error);
                showToast('当前音频格式可能不受浏览器支持');
            });
        }
    };

    dom.playBtn.addEventListener('click', togglePlay);
    dom.miniPlayBtn.addEventListener('click', event => {
        event.stopPropagation();
        togglePlay();
    });

    document.getElementById('prev-btn').addEventListener('click', () => {
        if (!state.currentQueue.length) return;
        state.currentIndex = getNextIndex(false);
        playSong(state.currentQueue[state.currentIndex]);
    });
    document.getElementById('next-btn').addEventListener('click', () => {
        if (!state.currentQueue.length) return;
        state.currentIndex = getNextIndex(true);
        playSong(state.currentQueue[state.currentIndex]);
    });
    dom.miniPrevBtn.addEventListener('click', event => {
        event.stopPropagation();
        document.getElementById('prev-btn').click();
    });
    dom.miniNextBtn.addEventListener('click', event => {
        event.stopPropagation();
        document.getElementById('next-btn').click();
    });
}

export function updatePlayState(isPlaying) {
    const playing = Boolean(isPlaying);
    state.isNativePlaying = playing;
    dom.playIconSvg.innerHTML = playing ? ICON_PAUSE : ICON_PLAY;
    dom.miniPlayIconSvg.innerHTML = playing ? ICON_PAUSE : ICON_PLAY;

    const label = playing ? '暂停' : '播放';
    dom.playBtn.setAttribute('aria-label', label);
    dom.playBtn.title = label;
    dom.miniPlayBtn.setAttribute('aria-label', label);
    dom.miniPlayBtn.title = label;
    dom.recordDisc.classList.toggle('playing', playing);
}

export function getNextIndex(isNext = true) {
    const queueLength = state.currentQueue.length;
    if (queueLength <= 1) return 0;

    if (state.playMode === 'shuffle') {
        let candidate = state.currentIndex;
        while (candidate === state.currentIndex) {
            candidate = Math.floor(Math.random() * queueLength);
        }
        return candidate;
    }

    return isNext
        ? (state.currentIndex + 1) % queueLength
        : (state.currentIndex - 1 + queueLength) % queueLength;
}

function getCoverUrl(track) {
    const rawCoverUrl = track?.cover || track?.pic || '';
    return rawCoverUrl
        ? `${API_BASE}/image?url=${encodeURIComponent(rawCoverUrl)}`
        : DEFAULT_COVER;
}

export async function playSong(track) {
    if (!track) return;

    const lyricRequestId = ++state.currentLyricsRequestId;
    const playableTrack = enrichTrackForLyrics(track, track.searchKeyword || state.lastSearchQuery);
    state.currentTrackObj = playableTrack;

    const title = playableTrack.title || playableTrack.lyricTitle || '未知歌曲';
    const artist = playableTrack.uploader || playableTrack.artist || playableTrack.lyricArtist || '未知歌手';
    const coverUrl = getCoverUrl(playableTrack);

    dom.songTitle.textContent = title;
    dom.songArtist.textContent = artist;
    dom.albumCover.src = coverUrl;
    dom.recordCover.src = coverUrl;
    dom.playerBlurBg.style.backgroundImage = `url("${coverUrl.replace(/"/g, '%22')}")`;

    const fallbackCover = event => {
        const image = event.currentTarget;
        image.onerror = null;
        image.src = DEFAULT_COVER;
    };
    dom.albumCover.onerror = fallbackCover;
    dom.recordCover.onerror = fallbackCover;

    dom.miniPlayer.classList.remove('hidden');
    document.getElementById('mini-title').textContent = title;
    document.getElementById('mini-artist').textContent = artist;
    const miniCover = document.getElementById('mini-cover');
    miniCover.src = coverUrl;
    miniCover.onerror = fallbackCover;

    checkIfFavorited();
    updatePlayState(false);
    state.lyricOffset = 0;
    updateOffsetDisplay();
    resetLyricsUI('正在解析高音质音源…');

    const directVideoId = String(playableTrack.id || playableTrack.videoId || '').trim();
    let videoId = directVideoId;
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
        try {
            const sourceUrl = new URL(String(playableTrack.url || ''));
            const pathParts = sourceUrl.pathname.split('/').filter(Boolean);
            videoId = sourceUrl.hostname.endsWith('youtu.be')
                ? (pathParts[0] || '')
                : (sourceUrl.searchParams.get('v') || pathParts.find(part => /^[A-Za-z0-9_-]{11}$/.test(part)) || '');
        } catch {
            videoId = '';
        }
    }
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
        resetLyricsUI('当前歌曲缺少有效的视频 ID');
        showToast('当前歌曲暂时无法播放');
        return;
    }

    const cacheKey = `id:${videoId}`;
    const legacyStreamUrl = `${API_BASE}/stream?url=${encodeURIComponent(playableTrack.url || '')}`
        + `&title=${encodeURIComponent(playableTrack.title || title)}`
        + `&artist=${encodeURIComponent(playableTrack.uploader || playableTrack.artist || artist)}`
        + `&userId=${encodeURIComponent(state.userId)}`;
    const streamUrl = `${API_BASE}/stream/${encodeURIComponent(videoId)}`
        + `?title=${encodeURIComponent(title)}`
        + `&artist=${encodeURIComponent(artist)}`
        + `&userId=${encodeURIComponent(state.userId)}`
        + `&auraCacheKey=${encodeURIComponent(cacheKey)}`
        + `&t=${Date.now()}`;

    if (window.AndroidNative?.playAudio) {
        try {
            if (window.AndroidNative.playAudioV2) {
                window.AndroidNative.playAudioV2(streamUrl, title, artist, coverUrl, legacyStreamUrl);
            } else if (window.AndroidNative.playAudio.length >= 4) {
                window.AndroidNative.playAudio(streamUrl, title, artist, coverUrl);
            } else {
                window.AndroidNative.playAudio(streamUrl, title, artist);
            }
        } catch (error) {
            console.error('[Aura] Android 播放接口调用失败', error);
            resetLyricsUI('播放接口调用失败');
            showToast('播放器启动失败');
        }
    } else if (dom.webAudio) {
        dom.webAudio.src = streamUrl;
        try {
            await dom.webAudio.play();
        } catch (error) {
            console.error('[Aura] 网页端播放失败', error);
            resetLyricsUI('网页端播放失败，当前音频格式可能不受支持');
            updatePlayState(false);
        }
    }

    loadRealLyrics(playableTrack, lyricRequestId);
}

export function resetLyricsUI(text = '正在加载…') {
    state.lyricsData = [];
    state.lyricNodes = [];
    state.currentLyricIndex = -1;
    const paragraph = document.createElement('p');
    paragraph.className = 'lyric-line';
    paragraph.textContent = text;
    dom.lyricsContainer.replaceChildren(paragraph);
    dom.lyricsContainer.scrollTop = 0;
}
