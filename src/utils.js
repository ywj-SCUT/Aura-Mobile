// utils.js
import { dom } from './store.js';

export function formatTime(seconds) {
    if (!Number.isFinite(Number(seconds)) || Number(seconds) < 0) return '00:00';
    const total = Math.floor(Number(seconds));
    const minutes = Math.floor(total / 60);
    const secs = total % 60;
    return `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export function cleanText(text = '') {
    return String(text)
        .replace(/&amp;/g, '&')
        .replace(/&#x27;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/[【\[(（][^】\])）]*(official|music|video|mv|lyrics?|lyric|audio|visualizer|live|cover|remix|version|full|hd|4k|1080p|pinyin|karaoke|instrumental|prod\.?|feat\.?|ft\.?|官方|歌词|拼音|中字|字幕|完整版|高清|现场|纯享版|无损|伴奏|翻唱|新歌|音频)[^】\])）]*[】\])）]/gi, ' ')
        .replace(/\b(official|music|video|mv|lyrics?|lyric|audio|visualizer|live|cover|remix|version|full|hd|4k|1080p|pinyin|karaoke|instrumental|prod\.?|feat\.?|ft\.?)\b/gi, ' ')
        .replace(/官方版?|歌词版|动态(拼音)?歌词|拼音|中字|字幕|完整版|高清|现场版?|纯享版|无损|伴奏|翻唱|新歌|音频/gi, ' ')
        .replace(/[＿_｜|/\\·•●★☆♪♫♬♩~～×]/g, ' ')
        .replace(/\s*-\s*/g, ' - ')
        .replace(/\s+/g, ' ')
        .trim();
}

export function cleanArtistName(text = '') {
    return cleanText(text)
        .replace(/- Topic/gi, '')
        .replace(/VEVO|Official|Records|Music|Studio|频道|頻道|Channel|Artist|歌手|工作室|音乐/gi, '')
        .replace(/\s+/g, ' ')
        .trim();
}

export function isLikelyRealArtist(name = '') {
    const normalized = cleanArtistName(name);
    if (!normalized || normalized.length < 2 || normalized.length > 50) return false;
    if (/studio|music|lyrics|lyric|channel|topic|records|official|vevo|karaoke|pinyin/i.test(normalized)) return false;
    return !/歌词|拼音|频道|頻道|工作室|音乐|官方|字幕|翻唱/.test(normalized);
}

export function parseSearchKeyword(keyword = '') {
    const query = cleanText(keyword);
    if (!query) return null;

    let match = query.match(/^(.{1,40}?)(?:的|唱的|演唱的)\s*(.{1,80})$/);
    if (match) return { artist: cleanArtistName(match[1]), title: cleanText(match[2]) };

    match = query.match(/^(.{1,40}?)\s*[《「『【]\s*(.{1,80}?)\s*[》」』】]/);
    if (match) return { artist: cleanArtistName(match[1]), title: cleanText(match[2]) };

    match = query.match(/^(.{1,40}?)\s*[-–—]\s*(.{1,80})$/);
    if (match) return { artist: cleanArtistName(match[1]), title: cleanText(match[2]) };

    match = query.match(/^([^\s]{1,40})\s+(.+)$/);
    if (match) return { artist: cleanArtistName(match[1]), title: cleanText(match[2]) };

    return { artist: '', title: query };
}

export function extractTrackInfo(track = {}) {
    const rawTitle = String(track.title || '');
    const uploader = String(track.uploader || '');

    if (track.lyricTitle || track.lyricArtist) {
        return {
            title: cleanText(track.lyricTitle || track.title || ''),
            artist: cleanArtistName(track.lyricArtist || track.uploader || ''),
            videoTitle: rawTitle,
            uploader
        };
    }

    let artist = '';
    let title = '';
    const keyword = track.searchKeyword || '';

    if (keyword) {
        const fromSearch = parseSearchKeyword(keyword);
        if (fromSearch?.title) {
            title = fromSearch.title;
            if (isLikelyRealArtist(fromSearch.artist)) artist = fromSearch.artist;
        }
    }

    if (!title) {
        const match = rawTitle.match(/^\s*([^《「『【\[\(（]{1,50})\s*[《「『【\[\(（]\s*([^》」』】\]\)）]{1,80})\s*[》」』】\]\)）]/);
        if (match) {
            artist = cleanArtistName(match[1]);
            title = cleanText(match[2]);
        }
    }

    if (!title) {
        const match = rawTitle.match(/^\s*(.{1,50}?)\s*[-–—]\s*(.{1,100})$/);
        if (match) {
            artist = cleanArtistName(match[1]);
            title = cleanText(match[2]);
        }
    }

    if (!title) {
        const bracket = rawTitle.match(/[《「『【]\s*([^》」』】]{1,80})\s*[》」』】]/);
        if (bracket?.[1]) title = cleanText(bracket[1]);
    }

    if (!title) title = cleanText(rawTitle);
    if (!isLikelyRealArtist(artist) && isLikelyRealArtist(uploader)) artist = cleanArtistName(uploader);

    if (artist && title) {
        const escaped = artist.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        try {
            title = title.replace(new RegExp(escaped, 'ig'), ' ');
        } catch (error) {
            console.debug('[Aura] 歌手名清理跳过', error);
        }
        title = cleanText(title);
    }

    if (!title) title = cleanText(rawTitle);
    return { title, artist, videoTitle: rawTitle, uploader };
}

export function enrichTrackForLyrics(track, searchKeyword = '') {
    const normalizedKeyword = searchKeyword || track.searchKeyword || '';
    const tempTrack = { ...track, searchKeyword: normalizedKeyword };
    const info = extractTrackInfo(tempTrack);
    return {
        ...track,
        searchKeyword: normalizedKeyword,
        lyricTitle: info.title,
        lyricArtist: info.artist,
        videoTitle: info.videoTitle
    };
}

export function parseLRC(lrcString) {
    const lines = String(lrcString || '').replace(/\r/g, '').split('\n');
    const parsed = [];

    for (const line of lines) {
        const timeTags = [...line.matchAll(/\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?]/g)];
        if (!timeTags.length) continue;

        const lyricText = line
            .replace(/\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?]/g, '')
            .replace(/<[^>]+>/g, '')
            .trim();
        if (!lyricText) continue;

        for (const tag of timeTags) {
            const time = Number.parseInt(tag[1], 10) * 60
                + Number.parseInt(tag[2], 10)
                + Number.parseInt((tag[3] || '0').padEnd(3, '0').slice(0, 3), 10) / 1000;
            parsed.push({ time, text: lyricText });
        }
    }

    parsed.sort((a, b) => a.time - b.time);

    // 同一时间戳若出现完全相同的歌词，仅保留一条，避免重复高亮。
    return parsed.filter((line, index, list) => {
        if (index === 0) return true;
        const previous = list[index - 1];
        return Math.abs(previous.time - line.time) > 0.03 || previous.text !== line.text;
    });
}

export function createSvgIcon(pathMarkup, {
    className = 'svg-icon',
    width = 24,
    height = 24,
    label = ''
} = {}) {
    const namespace = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(namespace, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(height));
    svg.setAttribute('class', className);
    svg.setAttribute('focusable', 'false');
    svg.setAttribute('aria-hidden', label ? 'false' : 'true');
    if (label) svg.setAttribute('aria-label', label);
    // pathMarkup 只允许来自本地常量，不接收网络或用户输入。
    svg.innerHTML = pathMarkup;
    return svg;
}

export function appendMultilineText(container, text) {
    const lines = String(text ?? '').split('\n');
    lines.forEach((line, index) => {
        if (index > 0) container.appendChild(document.createElement('br'));
        container.appendChild(document.createTextNode(line));
    });
}

export function createEmptyState(text, className = 'empty-state') {
    const element = document.createElement('li');
    element.className = className;
    element.textContent = text;
    return element;
}

export function renderSkeletonList(target, count = 5, { showCover = true } = {}) {
    target.replaceChildren();
    const fragment = document.createDocumentFragment();
    for (let index = 0; index < count; index += 1) {
        const item = document.createElement('li');
        item.className = `skeleton-row${showCover ? '' : ' skeleton-row-no-cover'}`;

        const lines = document.createElement('span');
        lines.className = 'skeleton-lines';
        const title = document.createElement('span');
        title.className = 'skeleton skeleton-title';
        const subtitle = document.createElement('span');
        subtitle.className = 'skeleton skeleton-subtitle';
        lines.append(title, subtitle);

        if (showCover) {
            const cover = document.createElement('span');
            cover.className = 'skeleton skeleton-cover';
            item.append(cover, lines);
        } else {
            item.appendChild(lines);
        }
        fragment.appendChild(item);
    }
    target.appendChild(fragment);
}

let toastTimer = null;
export function showToast(message, duration = 1800) {
    if (!dom.toast) return;
    dom.toast.textContent = String(message || '');
    dom.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => dom.toast.classList.remove('show'), duration);
}

const modalStates = new WeakMap();
const modalStack = [];

function getFocusableElements(modal) {
    return [...modal.querySelectorAll(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
    )].filter(element => !element.hidden && element.offsetParent !== null);
}

export function openAccessibleModal(modal, focusTarget = null, onEscape = null) {
    if (!modal) return;
    if (modalStates.has(modal)) closeAccessibleModal(modal);

    const previousFocus = document.activeElement;
    const handleKeydown = event => {
        if (modalStack[modalStack.length - 1] !== modal) return;

        if (event.key === 'Escape') {
            event.preventDefault();
            if (typeof onEscape === 'function') onEscape();
            else closeAccessibleModal(modal);
            return;
        }

        if (event.key !== 'Tab') return;
        const focusable = getFocusableElements(modal);
        if (focusable.length === 0) {
            event.preventDefault();
            modal.focus();
            return;
        }

        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
        }
    };

    modalStates.set(modal, { previousFocus, handleKeydown });
    modalStack.push(modal);
    modal.classList.add('open');
    modal.setAttribute('aria-hidden', 'false');
    document.addEventListener('keydown', handleKeydown);

    requestAnimationFrame(() => {
        const target = focusTarget || getFocusableElements(modal)[0] || modal;
        target.focus({ preventScroll: true });
    });
}

export function closeAccessibleModal(modal) {
    if (!modal) return;
    const state = modalStates.get(modal);
    modal.classList.remove('open');
    modal.setAttribute('aria-hidden', 'true');

    if (state) {
        document.removeEventListener('keydown', state.handleKeydown);
        modalStates.delete(modal);
        const stackIndex = modalStack.lastIndexOf(modal);
        if (stackIndex >= 0) modalStack.splice(stackIndex, 1);
        if (state.previousFocus instanceof HTMLElement) {
            state.previousFocus.focus({ preventScroll: true });
        }
    }
}

export function showCustomDialog({
    title = '提示',
    message = '',
    buttons = [{ text: '确定', type: 'primary', resolveValue: true }]
}) {
    return new Promise(resolve => {
        const dialog = document.getElementById('custom-dialog');
        const titleElement = document.getElementById('dialog-title');
        const messageElement = document.getElementById('dialog-message');
        const actionsElement = document.getElementById('dialog-actions');
        const closeButton = document.getElementById('dialog-close-btn');

        titleElement.textContent = String(title);
        messageElement.textContent = String(message);
        actionsElement.replaceChildren();

        let settled = false;
        const finish = value => {
            if (settled) return;
            settled = true;
            closeAccessibleModal(dialog);
            resolve(value);
        };

        closeButton.onclick = () => finish(null);

        buttons.forEach(buttonConfig => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = buttonConfig.type === 'primary'
                ? 'dialog-action primary-button'
                : 'dialog-action secondary-button';
            button.textContent = String(buttonConfig.text || '确定');
            button.addEventListener('click', () => finish(buttonConfig.resolveValue));
            actionsElement.appendChild(button);
        });

        openAccessibleModal(dialog, actionsElement.querySelector('button'), () => finish(null));
    });
}
