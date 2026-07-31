// ui.js
import { DEFAULT_COVER, ICON_TRASH, dom, state } from './store.js';
import { renderFavorites } from './services.js';
import { playSong, resetLyricsUI, updatePlayState } from './audio.js';
import {
    closeAccessibleModal,
    createEmptyState,
    createSvgIcon,
    openAccessibleModal,
    showToast
} from './utils.js';

const THEMES = {
    red: {
        primary: '#fa233b', primaryText: '#ffffff', bgMain: '#f2f2f6', bgCard: '#ffffff',
        surfaceSoft: 'rgba(0,0,0,0.055)', inputBg: 'rgba(0,0,0,0.06)',
        textMain: '#111111', textSub: '#6e6e73', border: 'rgba(0,0,0,0.09)',
        overlay: 'rgba(0,0,0,0.42)', focus: 'rgba(250,35,59,0.34)', themeColor: '#f2f2f6'
    },
    blue: {
        primary: '#007aff', primaryText: '#ffffff', bgMain: '#f3f8fd', bgCard: '#ffffff',
        surfaceSoft: 'rgba(0,82,160,0.07)', inputBg: 'rgba(0,82,160,0.08)',
        textMain: '#111111', textSub: '#65717d', border: 'rgba(0,82,160,0.12)',
        overlay: 'rgba(0,0,0,0.42)', focus: 'rgba(0,122,255,0.32)', themeColor: '#f3f8fd'
    },
    green: {
        primary: '#31c27c', primaryText: '#ffffff', bgMain: '#f2f7f4', bgCard: '#ffffff',
        surfaceSoft: 'rgba(0,105,65,0.07)', inputBg: 'rgba(0,105,65,0.08)',
        textMain: '#111111', textSub: '#65706a', border: 'rgba(0,105,65,0.12)',
        overlay: 'rgba(0,0,0,0.42)', focus: 'rgba(49,194,124,0.34)', themeColor: '#f2f7f4'
    },
    purple: {
        primary: '#af52de', primaryText: '#ffffff', bgMain: '#f8f3fb', bgCard: '#ffffff',
        surfaceSoft: 'rgba(91,33,122,0.07)', inputBg: 'rgba(91,33,122,0.08)',
        textMain: '#111111', textSub: '#716879', border: 'rgba(91,33,122,0.12)',
        overlay: 'rgba(0,0,0,0.42)', focus: 'rgba(175,82,222,0.34)', themeColor: '#f8f3fb'
    },
    white: {
        primary: '#333333', primaryText: '#ffffff', bgMain: '#f5f5f5', bgCard: '#ffffff',
        surfaceSoft: 'rgba(0,0,0,0.055)', inputBg: 'rgba(0,0,0,0.06)',
        textMain: '#111111', textSub: '#6e6e73', border: 'rgba(0,0,0,0.11)',
        overlay: 'rgba(0,0,0,0.42)', focus: 'rgba(51,51,51,0.28)', themeColor: '#f5f5f5'
    },
    black: {
        primary: '#ffffff', primaryText: '#111111', bgMain: '#111111', bgCard: '#202024',
        surfaceSoft: 'rgba(255,255,255,0.09)', inputBg: 'rgba(255,255,255,0.1)',
        textMain: '#ffffff', textSub: '#b2b2b7', border: 'rgba(255,255,255,0.13)',
        overlay: 'rgba(0,0,0,0.62)', focus: 'rgba(255,255,255,0.34)', themeColor: '#111111'
    }
};

function applyTheme(themeName, persist = true) {
    const theme = THEMES[themeName] || THEMES.red;
    state.selectedTheme = THEMES[themeName] ? themeName : 'red';
    const root = document.documentElement;

    root.style.setProperty('--primary', theme.primary);
    root.style.setProperty('--primary-text', theme.primaryText);
    root.style.setProperty('--bg-main', theme.bgMain);
    root.style.setProperty('--bg-card', theme.bgCard);
    root.style.setProperty('--surface-soft', theme.surfaceSoft);
    root.style.setProperty('--input-bg', theme.inputBg);
    root.style.setProperty('--text-main', theme.textMain);
    root.style.setProperty('--text-sub', theme.textSub);
    root.style.setProperty('--border-color', theme.border);
    root.style.setProperty('--overlay-bg', theme.overlay);
    root.style.setProperty('--focus-ring', theme.focus);
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme.themeColor);

    document.querySelectorAll('.theme-circle').forEach(circle => {
        const selected = circle.dataset.theme === state.selectedTheme;
        circle.classList.toggle('selected', selected);
        circle.setAttribute('aria-pressed', String(selected));
    });

    if (persist) localStorage.setItem('aura_theme', state.selectedTheme);
}

function applyLyricFontSize(size, persist = true) {
    state.baseFontSize = Math.min(34, Math.max(18, Number(size) || 24));
    document.documentElement.style.setProperty('--lyric-base-size', `${state.baseFontSize}px`);
    document.getElementById('font-size-display').textContent = `${state.baseFontSize}px`;
    document.getElementById('font-minus-btn').disabled = state.baseFontSize <= 18;
    document.getElementById('font-plus-btn').disabled = state.baseFontSize >= 34;
    if (persist) localStorage.setItem('aura_lyric_size', String(state.baseFontSize));
}

function expandPlayer() {
    dom.pagePlayer.classList.add('expanded');
    dom.pagePlayer.setAttribute('aria-hidden', 'false');
}

function collapsePlayer() {
    dom.pagePlayer.classList.remove('expanded', 'lyrics-fullscreen', 'controls-hidden');
    dom.pagePlayer.setAttribute('aria-hidden', 'true');
    dom.toggleLyricBtn.setAttribute('aria-pressed', 'false');
    dom.toggleControlsBtn?.setAttribute('aria-expanded', 'true');
}

export function initUI() {
    const settingsButton = document.getElementById('settings-btn');
    const settingsModal = document.getElementById('settings-modal');
    const closeSettingsButton = document.getElementById('close-settings-btn');
    const themeCircles = document.querySelectorAll('.theme-circle');
    const effectButtons = document.querySelectorAll('.effect-btn');

    applyTheme(state.selectedTheme, false);
    applyLyricFontSize(state.baseFontSize, false);

    settingsButton.addEventListener('click', () => {
        openAccessibleModal(settingsModal, document.querySelector('.effect-btn'), () => closeAccessibleModal(settingsModal));
    });
    closeSettingsButton.addEventListener('click', () => closeAccessibleModal(settingsModal));
    settingsModal.addEventListener('click', event => {
        if (event.target === settingsModal) closeAccessibleModal(settingsModal);
    });

    themeCircles.forEach(circle => {
        circle.addEventListener('click', () => applyTheme(circle.dataset.theme));
    });

    document.getElementById('font-minus-btn').addEventListener('click', () => {
        applyLyricFontSize(state.baseFontSize - 1);
    });
    document.getElementById('font-plus-btn').addEventListener('click', () => {
        applyLyricFontSize(state.baseFontSize + 1);
    });

    const savedEffect = localStorage.getItem('aura_audio_effect') || 'normal';
    function setEffectActive(effectType, notifyNative = false) {
        effectButtons.forEach(button => {
            const active = button.dataset.effect === effectType;
            button.classList.toggle('active', active);
            button.setAttribute('aria-pressed', String(active));
        });
        localStorage.setItem('aura_audio_effect', effectType);
        if (notifyNative && window.AndroidNative?.setAudioEffect) {
            window.AndroidNative.setAudioEffect(effectType);
        }
    }
    setEffectActive(document.querySelector(`.effect-btn[data-effect="${savedEffect}"]`) ? savedEffect : 'normal');
    effectButtons.forEach(button => {
        button.addEventListener('click', () => {
            setEffectActive(button.dataset.effect, true);
            showToast(`已切换到${button.textContent.trim()}`);
        });
    });

    // ================= 顶部 Tab 与底部纯文字导航 =================
    const topTabs = document.querySelectorAll('.top-tab-item');
    const subTabs = document.querySelectorAll('.sub-tab-view');
    topTabs.forEach(tab => {
        tab.addEventListener('click', () => {
            topTabs.forEach(item => {
                const active = item === tab;
                item.classList.toggle('active', active);
                item.setAttribute('aria-selected', String(active));
            });
            subTabs.forEach(panel => {
                const active = panel.id === tab.dataset.tab;
                panel.classList.toggle('active', active);
                panel.hidden = !active;
            });
        });
    });

    function switchPage(targetId) {
        dom.navItems.forEach(nav => {
            const active = nav.dataset.target === targetId;
            nav.classList.toggle('active', active);
            if (active) nav.setAttribute('aria-current', 'page');
            else nav.removeAttribute('aria-current');
        });
        dom.pages.forEach(page => page.classList.toggle('active', page.id === targetId));
        if (targetId === 'page-fav') renderFavorites();
    }
    dom.navItems.forEach(item => {
        item.addEventListener('click', () => switchPage(item.dataset.target));
    });

    // ================= 播放器 =================
    document.querySelector('.mini-player-main').addEventListener('click', expandPlayer);
    dom.collapsePlayerBtn.addEventListener('click', collapsePlayer);

    dom.toggleLyricBtn.addEventListener('click', () => {
        dom.pagePlayer.classList.toggle('lyrics-fullscreen');
        const fullScreenLyrics = dom.pagePlayer.classList.contains('lyrics-fullscreen');
        dom.toggleLyricBtn.title = fullScreenLyrics ? '显示唱片' : '全屏歌词';
        dom.toggleLyricBtn.setAttribute('aria-label', fullScreenLyrics ? '显示唱片' : '切换全屏歌词');
        dom.toggleLyricBtn.setAttribute('aria-pressed', String(fullScreenLyrics));
        if (!fullScreenLyrics) {
            dom.pagePlayer.classList.remove('controls-hidden');
            dom.toggleControlsBtn?.setAttribute('aria-expanded', 'true');
        }
    });

    dom.toggleControlsBtn?.addEventListener('click', event => {
        event.stopPropagation();
        dom.pagePlayer.classList.toggle('controls-hidden');
        const expanded = !dom.pagePlayer.classList.contains('controls-hidden');
        dom.toggleControlsBtn.setAttribute('aria-expanded', String(expanded));
    });

    // ================= 队列抽屉 =================
    function openDrawer() {
        renderDrawerList();
        dom.queueDrawer.classList.add('open');
        dom.queueBackdrop.classList.add('open');
        dom.queueDrawer.setAttribute('aria-hidden', 'false');
        requestAnimationFrame(() => dom.closeDrawerBtn.focus());
    }

    function closeDrawer() {
        dom.queueDrawer.classList.remove('open');
        dom.queueBackdrop.classList.remove('open');
        dom.queueDrawer.setAttribute('aria-hidden', 'true');
        dom.queueBtn.focus({ preventScroll: true });
    }

    dom.queueBtn.addEventListener('click', openDrawer);
    dom.closeDrawerBtn.addEventListener('click', closeDrawer);
    dom.queueBackdrop.addEventListener('click', closeDrawer);

    function handleBack() {
        if (dom.queueDrawer.classList.contains('open')) {
            closeDrawer();
            return true;
        }
        if (settingsModal.classList.contains('open')) {
            closeAccessibleModal(settingsModal);
            return true;
        }
        const accountModal = document.getElementById('account-modal');
        if (accountModal.classList.contains('open')) {
            closeAccessibleModal(accountModal);
            return true;
        }
        if (dom.pagePlayer.classList.contains('expanded')) {
            collapsePlayer();
            return true;
        }
        return false;
    }

    window.AuraHandleBack = handleBack;
    window.addEventListener('keydown', event => {
        if (event.key === 'Escape' && handleBack()) event.preventDefault();
    });
}

export function renderDrawerList() {
    dom.drawerList.replaceChildren();
    dom.queueCount.textContent = String(state.currentQueue.length);

    if (!state.currentQueue.length) {
        dom.drawerList.appendChild(createEmptyState('播放队列为空'));
        return;
    }

    const fragment = document.createDocumentFragment();
    state.currentQueue.forEach((track, index) => {
        const listItem = document.createElement('li');
        listItem.className = index === state.currentIndex ? 'active' : '';

        const trackButton = document.createElement('button');
        trackButton.type = 'button';
        trackButton.className = 'drawer-track-info';
        trackButton.setAttribute('aria-label', `播放 ${track.title || '未知歌曲'}`);

        const title = document.createElement('span');
        title.className = 'drawer-title';
        title.textContent = track.title || '未知歌曲';
        const artist = document.createElement('span');
        artist.className = 'drawer-artist';
        artist.textContent = track.uploader || track.artist || '未知歌手';
        trackButton.append(title, artist);

        trackButton.addEventListener('click', () => {
            state.currentIndex = index;
            playSong(state.currentQueue[state.currentIndex]);
            dom.queueDrawer.classList.remove('open');
            dom.queueBackdrop.classList.remove('open');
            dom.queueDrawer.setAttribute('aria-hidden', 'true');
        });

        const deleteButton = document.createElement('button');
        deleteButton.type = 'button';
        deleteButton.className = 'drawer-del-btn icon-only-button';
        deleteButton.setAttribute('aria-label', `从队列删除 ${track.title || '未知歌曲'}`);
        deleteButton.title = '从队列删除';
        deleteButton.appendChild(createSvgIcon(ICON_TRASH, { className: 'small-svg-icon' }));
        deleteButton.addEventListener('click', event => {
            event.stopPropagation();
            state.currentQueue.splice(index, 1);

            if (index === state.currentIndex) {
                if (state.currentQueue.length > 0) {
                    state.currentIndex %= state.currentQueue.length;
                    playSong(state.currentQueue[state.currentIndex]);
                } else {
                    if (window.AndroidNative?.pauseAudio) window.AndroidNative.pauseAudio();
                    else if (dom.webAudio) {
                        dom.webAudio.pause();
                        dom.webAudio.removeAttribute('src');
                        dom.webAudio.load();
                    }
                    state.currentTrackObj = null;
                    state.currentAudioDuration = 0;
                    state.currentAudioTime = 0;
                    dom.songTitle.textContent = 'Aura 音乐';
                    dom.songArtist.textContent = '让声音更有温度';
                    dom.albumCover.src = DEFAULT_COVER;
                    dom.playerBlurBg.style.backgroundImage = `url("${DEFAULT_COVER}")`;
                    updatePlayState(false);
                    resetLyricsUI('暂无播放');
                    dom.miniPlayer.classList.add('hidden');
                }
            } else if (index < state.currentIndex) {
                state.currentIndex -= 1;
            }

            renderDrawerList();
        });

        listItem.append(trackButton, deleteButton);
        fragment.appendChild(listItem);
    });
    dom.drawerList.appendChild(fragment);
}
