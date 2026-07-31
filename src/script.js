// script.js
import { initUI } from './ui.js';
import { initAudio } from './audio.js';
import { initServices } from './services.js';
import { showToast } from './utils.js';

document.addEventListener('DOMContentLoaded', () => {
    try {
        initUI();
        initAudio();
        initServices();
    } catch (error) {
        console.error('[Aura] 前端初始化失败', error);
        showToast('界面初始化失败，请重新打开应用', 4000);
    }
});
