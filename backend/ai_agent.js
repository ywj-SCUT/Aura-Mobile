const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ================== 配置区域 ==================
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const DEEPSEEK_API_URL = 'https://api.deepseek.com/v1/chat/completions';
const MEMORY_FILE = path.join(__dirname, 'user_memory.json');

// 🌟 内部与外部路由配置
const LOCAL_API_PORT = process.env.PORT || 3000;
const LOCAL_API_BASE = `http://127.0.0.1:${LOCAL_API_PORT}`;
const EXTERNAL_SERVER_URL = (process.env.EXTERNAL_URL || LOCAL_API_BASE).replace(/\/$/, '');

// ================== 加密播放令牌 ==================
if (!DEEPSEEK_API_KEY || !process.env.URL_SECRET) {
    throw new Error('DEEPSEEK_API_KEY and URL_SECRET must be configured');
}

const URL_SECRET = crypto.createHash('sha256').update(process.env.URL_SECRET).digest();
const LEGACY_IV = Buffer.alloc(16, 0);

function encryptToken(videoId, title, userId) {
    const payload = JSON.stringify({ videoId, userId, title });
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', URL_SECRET, iv);
    const encrypted = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v1.${Buffer.concat([iv, tag, encrypted]).toString('base64url')}`;
}

function decryptToken(token) {
    try {
        if (typeof token !== 'string' || !token) return null;
        let data;
        if (token.startsWith('v1.')) {
            const packed = Buffer.from(token.slice(3), 'base64url');
            if (packed.length < 29) return null;
            const iv = packed.subarray(0, 12);
            const tag = packed.subarray(12, 28);
            const encrypted = packed.subarray(28);
            const decipher = crypto.createDecipheriv('aes-256-gcm', URL_SECRET, iv);
            decipher.setAuthTag(tag);
            const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
            data = JSON.parse(decrypted);
        } else {
            const decipher = crypto.createDecipheriv('aes-256-ctr', URL_SECRET, LEGACY_IV);
            let decrypted = decipher.update(token, 'base64url', 'utf8');
            decrypted += decipher.final('utf8');
            const [videoId, userId, title] = decrypted.split('|');
            data = { videoId, userId, title };
        }
        if (!/^[A-Za-z0-9_-]{11}$/.test(data.videoId || '') || typeof data.userId !== 'string' || typeof data.title !== 'string') {
            return null;
        }
        return data;
    } catch (e) {
        console.error("❌ Token 解密失败:", e.message);
        return null;
    }
}

// ================== 记忆管理系统 ==================
let memoryStore = {};

if (fs.existsSync(MEMORY_FILE)) {
    try {
        fs.chmodSync(MEMORY_FILE, 0o600);
        const data = JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf-8'));
        if (data.playHistory && Array.isArray(data.playHistory)) {
            memoryStore['guest'] = data;
        } else {
            memoryStore = data;
        }
    } catch (e) {
        console.error('⚠️ 加载 AI 记忆失败，将使用全新大脑', e);
    }
}

function getUserMemory(userId) {
    if (!memoryStore[userId]) {
        memoryStore[userId] = { playHistory: [], chatContext: [], recentDaily: [], backgroundContext: "" };
    }
    if (memoryStore[userId].backgroundContext === undefined) {
        memoryStore[userId].backgroundContext = "";
    }
    return memoryStore[userId];
}

function saveMemory() {
    try {
        const tempFile = `${MEMORY_FILE}.${process.pid}.tmp`;
        fs.writeFileSync(tempFile, JSON.stringify(memoryStore, null, 2), { encoding: 'utf8', mode: 0o600 });
        fs.renameSync(tempFile, MEMORY_FILE);
    } catch (e) {
        console.error('⚠️ 保存 AI 记忆失败', e);
    }
}

function recordPlayHistory(userId, songName, artist) {
    if (!songName || !artist || songName === '未知歌曲') return;

    const userMemory = getUserMemory(userId);
    const track = `${artist} - ${songName}`;

    userMemory.playHistory = userMemory.playHistory.filter(t => t !== track);
    userMemory.playHistory.unshift(track);

    if (userMemory.playHistory.length > 50) userMemory.playHistory.pop();
    saveMemory();
}

async function compressMemoryIfNeeded(userId) {
    const mem = getUserMemory(userId);
    if (mem.chatContext.length > 12) {
        const toCompress = mem.chatContext.slice(0, 8);
        mem.chatContext = mem.chatContext.slice(8);

        const historyText = toCompress.map(m => `${m.role === 'user' ? '用户' : 'AI朋友'}: ${m.content}`).join('\n');

        try {
            const resp = await axios.post(DEEPSEEK_API_URL, {
                model: 'deepseek-v4-flash',
                messages: [{
                    role: 'user',
                    content: `请用一两句话总结以下对话中用户的情绪状态和核心偏好。之前的总结：【${mem.backgroundContext}】\n\n新对话记录：\n${historyText}`
                }],
                temperature: 0.3,
                max_tokens: 150
            }, { headers: { 'Authorization': `Bearer ${DEEPSEEK_API_KEY}` } });

            mem.backgroundContext = resp.data.choices[0].message.content;
            saveMemory();
            console.log(`🧠 [Memory] ${userId} 记忆已压缩更新`);
        } catch (e) {
            mem.chatContext = [...toCompress, ...mem.chatContext];
        }
    }
}

// ================== 核心检索模块 ==================

async function getNetworkTime() {
    try {
        const resp = await axios.get("http://api.m.taobao.com/rest/api3.do?api=mtop.common.getTimestamp", { timeout: 3000 });
        if (resp.data && resp.data.data && resp.data.data.t) {
            return new Date(Number(resp.data.data.t)).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
        }
    } catch (e) {}
    return new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
}

// 🌟 1. 高质量音源抓取 (AES 加密超短直连版)
async function searchAudioUrl(query, userId) {
    try {
        console.log(`🔍 [AI内部路由] 请求 yt-dlp 音源: ${query}`);
        const url = `${LOCAL_API_BASE}/api/search?q=${encodeURIComponent(query)}`;
        const resp = await axios.get(url, { timeout: 25000 });

        if (resp.data && Array.isArray(resp.data) && resp.data.length > 0) {
            const tracksInfo = [];
            const appendLinks = [];

            resp.data.slice(0, 3).forEach(t => {
                let safeTitle = t.title.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '');

                let videoId = t.url;
                const ytMatch = t.url.match(/(?:v=|youtu\.be\/)([^&]+)/);
                if (ytMatch && ytMatch[1]) {
                    videoId = ytMatch[1];
                }

                let fallbackTitle = safeTitle.length > 10 ? safeTitle.substring(0, 10) : safeTitle;
                const token = encryptToken(videoId, fallbackTitle, userId);
                const streamLink = `${EXTERNAL_SERVER_URL}/api/s?t=${token}`;

                tracksInfo.push(`- ${safeTitle} (来源: ${t.uploader})`);
                appendLinks.push(`🎵 ${safeTitle}\n${streamLink}`);
            });

            return {
                context: `【优质音源检索成功】已找到以下歌曲：\n${tracksInfo.join('\n')}\n(提示：请用幽默风趣的朋友口吻告诉用户找好了。🚨严重警告：绝对不要在你的回复中输出任何包含 http 的链接，也绝不要输出“👇播放直通车”这样的引导语！系统会自动隐形追加！)`,
                appendContent: `\n\n👇 专属播放直通车 👇\n${appendLinks.join('\n\n')}`
            };
        }
        return {
            context: "【音频检索】未能找到该歌曲的有效链接。请用朋友的口吻安抚并调侃一下，然后换首歌推荐。",
            appendContent: ""
        };
    } catch (e) {
        console.error("❌ AI 内部请求音源失败:", e.message);
        return {
            context: "【音频检索】服务器音源解析引擎繁忙，暂未获取到URL。请和用户解释一下并随便聊点别的。",
            appendContent: ""
        };
    }
}

// 2. 完整版多源歌词聚合抓取
async function searchLyrics(query) {
    try {
        console.log(`🔍 [AI内部路由] 请求全网聚合歌词: ${query}`);
        const url = `${LOCAL_API_BASE}/api/lyrics?q=${encodeURIComponent(query)}`;
        const resp = await axios.get(url, { timeout: 15000 });

        if (resp.data && resp.data.lyrics) {
            let cleanLyrics = resp.data.lyrics.substring(0, 1500);
            let translationInfo = resp.data.tlyric ? "\n(带有中文翻译)" : "";
            return `【全网歌词聚合检索成功】\n数据源：${resp.data.source}\n歌曲：${resp.data.matchedTitle} - ${resp.data.matchedArtist} ${translationInfo}\n\n完整歌词内容：\n${cleanLyrics}\n\n(提示：请排版后发给用户，你也可以作为朋友挑选一句做点幽默解读！切勿瞎编。)`;
        }

        console.log(`⚠️ [AI内部路由] 聚合API未命中，触发大模型记忆背诵模式`);
        return `【内部API未找到该歌词】后台暂未抓取到 ${query} 的精确歌词。请立刻调用你的【内置知识库】背诵这首歌的歌词，把你背下来的发给用户即可。`;

    } catch (e) {
        console.error("❌ AI 内部请求歌词超时/失败:", e.message);
        return `【歌词服务请求超时】请凭借记忆完整背出 ${query} 的歌词并发给用户！`;
    }
}

// 3. 常规网页检索
async function searchWeb(query) {
    if (query.includes("时间") || query.includes("几点") || query.includes("日期")) {
        return `【实时时钟】当前准确的北京时间是：${await getNetworkTime()}。`;
    }
    try {
        const encodedQuery = encodeURIComponent(query);
        const headers = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/122.0.0.0 Safari/537.36" };
        const results = [];
        let count = 0;

        try {
            const soUrl = `https://www.so.com/s?q=${encodedQuery}`;
            const soResp = await axios.get(soUrl, { headers, timeout: 6000 });
            const soRegex = /<h3 class="res-title[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="res-desc[^>]*>([\s\S]*?)<\/div>/gi;
            let match;
            while ((match = soRegex.exec(soResp.data)) !== null && count < 5) {
                results.push(`- ${match[1].replace(/<[^>]+>/g, '').trim()}\n  ${match[2].replace(/<[^>]+>/g, '').trim().substring(0, 150)}`); count++;
            }
        } catch (e) {}

        if (results.length === 0) {
            const bingUrl = `https://cn.bing.com/search?q=${encodedQuery}`;
            const bingResp = await axios.get(bingUrl, { headers, timeout: 6000 });
            const bingRegex = /<li class="b_algo"[^>]*>[\s\S]*?<h2[^>]*><a[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<p[^>]*>|<div class="b_caption"[^>]*>|class="b_lineclamp[^>]*>)([\s\S]*?)(?:<\/p>|<\/div>)/gi;
            let bMatch;
            while ((bMatch = bingRegex.exec(bingResp.data)) !== null && count < 5) {
                results.push(`- ${bMatch[1].replace(/<[^>]+>/g, '').trim()}\n  ${bMatch[2].replace(/<[^>]+>/g, '').trim().substring(0, 150)}`); count++;
            }
        }
        return results.length > 0 ? `网络搜索摘要：\n${results.join('\n\n')}` : "未能抓取到网页摘要，请靠你自身知识库回答。";
    } catch (error) {
        return "网络搜索异常。";
    }
}

// 4. 意图极速路由引擎 (极致优化提速版)
async function detectIntent(text) {
    const txt = text.trim();

    // 🚀 [极速通道]：拦截 80% 的常规请求，延迟瞬间降为 0 毫秒！
    if (/^(你好|哈喽|在吗|嗨|hello|hi|早上好|晚上好|聊聊天|你是谁)$/i.test(txt)) {
        return { intent: "CHAT", query: txt };
    }
    const lyricsMatch = txt.match(/我想看(.*?)的?歌词|查(.*?)的?歌词|(.*?)歌词$/);
    if (lyricsMatch) {
        return { intent: "LYRICS", query: (lyricsMatch[1] || lyricsMatch[2] || lyricsMatch[3]).trim() };
    }
    const audioMatch = txt.match(/^(?:我想听|播放|放一首|来一首|点一首|搜一首|帮我找)(.*)/);
    if (audioMatch && audioMatch[1].trim()) {
        return { intent: "AUDIO", query: audioMatch[1].trim() };
    }

    try {
        const resp = await axios.post(DEEPSEEK_API_URL, {
            model: 'deepseek-v4-flash',
            messages: [{
                role: 'user',
                content: `作为一个AI路由系统，请严格返回 JSON：
                {"intent": "AUDIO" | "LYRICS" | "WIKI" | "WEB" | "CHAT", "query": "提取的搜索词"}
                原话：${text}`
            }],
            response_format: { type: "json_object" },
            temperature: 0.1,
            max_tokens: 50
        }, { headers: { 'Authorization': `Bearer ${DEEPSEEK_API_KEY}` } });

        return JSON.parse(resp.data.choices[0].message.content);
    } catch (e) {
        return { intent: "CHAT", query: text };
    }
}

/**
 * 🌟 智能主页推荐系统
 */
async function getRecommendations(userId) {
    const userMemory = getUserMemory(userId);
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;

    const searchKeyword = `${year}年${month}月 抖音最新爆火BGM 网易云热歌榜 酷狗飙升榜 流行新歌`;
    const hotDataSearch = await searchWeb(searchKeyword);

    const history = userMemory.playHistory.slice(0, 20).join(', ');
    const recentDaily = userMemory.recentDaily.slice(0, 30).join(', ');

    const prompt = `你是一个极其专业的AI音乐推荐引擎。时间：${year}年${month}月。用户ID：${userId}。
    ===== 最新数据 =====\n${hotDataSearch}\n====================
    用户常听：${history || '暂无'}。近期已推（避开）：${recentDaily || '无'}。
    请严格返回 JSON 对象格式，不要带 Markdown：
    {"recommendations": [
        {"title": "歌名", "artist": "歌手名", "reason": "10字理由", "type": "personalized"},
        {"title": "歌名", "artist": "歌手名", "reason": "10字理由", "type": "daily"},
        {"title": "歌名", "artist": "歌手名", "reason": "10字理由", "type": "hot"}
    ]}`;

    try {
        const response = await axios.post(DEEPSEEK_API_URL, {
            model: 'deepseek-v4-flash',
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.8,
            reasoning_effort: "high",
            thinking: { type: "enabled" },
            response_format: { type: "json_object" }
        }, {
            headers: { 'Authorization': `Bearer ${DEEPSEEK_API_KEY}`, 'Content-Type': 'application/json' },
            timeout: 45000
        });

        let content = response.data.choices[0].message.content;
        let cleanContent = content.replace(/```json/g, '').replace(/```/g, '').trim();
        cleanContent = cleanContent.replace(/\*/g, '');

        const result = JSON.parse(cleanContent);
        const recList = result.recommendations || [];

        const newDaily = recList.filter(i => i.type === 'daily').map(i => `${i.artist} - ${i.title}`);
        userMemory.recentDaily = [...newDaily, ...userMemory.recentDaily].slice(0, 50);
        saveMemory();

        return recList;
    } catch (error) {
        console.error(`❌ [${userId}] AI 智能分析推荐失败:`, error.message);
        throw new Error('AI 分析系统开小差了，请稍后再试');
    }
}

// ================== AI 聊天系统 ==================

async function* chatWithAIStream(userId, userMessage) {
    const userMemory = getUserMemory(userId);
    let searchInfo = "【无需联网】";
    let appendLinksText = "";

    const intentData = await detectIntent(userMessage);
    console.log(`🧭 [Router - ${userId}] 识别意图: ${intentData.intent}, 搜索词: ${intentData.query}`);

    // ⚡ 拟人化秒回反馈机制
    if (intentData.intent === 'AUDIO') {
        yield "🎵 正在去曲库翻找，稍等一下哥们...\n\n";
        const audioResult = await searchAudioUrl(intentData.query, userId);
        if (typeof audioResult === 'object') {
            searchInfo = audioResult.context;
            appendLinksText = audioResult.appendContent;
        } else {
            searchInfo = audioResult;
        }
    } else if (intentData.intent === 'LYRICS') {
        yield "🎤 正在全网抓取最新歌词，马上来...\n\n";
        searchInfo = await searchLyrics(intentData.query);
    } else if (intentData.intent === 'WIKI') {
        yield "🌐 正在翻阅百科资料库...\n\n";
        searchInfo = await searchWeb(intentData.query + " 个人资料 演艺经历");
    } else if (intentData.intent === 'WEB') {
        yield "🌐 正在连网检索信息...\n\n";
        searchInfo = await searchWeb(intentData.query);
    }

    const history = userMemory.playHistory.slice(0, 20).join(', ');
    const bgContext = userMemory.backgroundContext ? `【往期情感记忆】：${userMemory.backgroundContext}` : '';

    const systemPrompt = `
    你是一个幽默风趣、极具音乐素养且能敏锐感知情绪的AI好朋友。
    用户的ID是：${userId}。

    ${bgContext}
    【用户的近期听歌记录】：${history || '暂无数据'}
    【后台抓取资料】：\n${searchInfo}

    【行为准则】：
    1. 角色人设：懂倾听、幽默风趣的朋友。能根据情绪切换风格。绝不自称“姐姐”，拒绝做作。
    2. 分享音乐：【严重警告】系统底层已完全接管播放链接的生成！如果资料里找到了歌曲，你只需自然地说“歌帮你找好了，在下面直接点”，**绝对不要自己输出任何包含 http 或 url 的代码**，也**绝不输出“👇播放直通车👇”这样的排版符**！系统会自动追加。
    3. 分享歌词：直接使用发给你的准确歌词排版并回复，可以挑一句幽默点评；未找到则在内置记忆中搜索并完整输出，绝不瞎编。
    4. 歌手百科：像朋友八卦聊天一样娓娓道来。
    5. 排版要求：严禁使用 Markdown 符号（如*、#），直接输出自然文本即可。
    `;

    // 🌟 终极防污染核心：记忆物理脱敏
    // 强制过滤历史对话里的所有旧链接，AI 根本看不到以前的链接格式，就绝对无法再模仿/捏造！
    const cleanHistoryContext = userMemory.chatContext.map(m => ({
        role: m.role,
        content: m.content.replace(/https?:\/\/[^\s]+/gi, '[链接已被系统自动隐藏]')
    }));

    const messages = [
        { role: 'system', content: systemPrompt },
        ...cleanHistoryContext,
        { role: 'user', content: userMessage }
    ];

    try {
        const response = await axios.post(DEEPSEEK_API_URL, {
            model: 'deepseek-v4-flash',
            messages: messages,
            temperature: 0.75,
            max_tokens: 600,
            stream: true
        }, {
            headers: { 'Authorization': `Bearer ${DEEPSEEK_API_KEY}`, 'Content-Type': 'application/json' },
            responseType: 'stream',
            timeout: 25000
        });

        let fullReply = "";

        for await (const chunk of response.data) {
            const lines = chunk.toString('utf8').split('\n');
            for (const line of lines) {
                if (line.trim() === 'data: [DONE]') break;
                if (line.startsWith('data: ')) {
                    try {
                        const parsed = JSON.parse(line.slice(6));
                        const content = parsed.choices[0].delta.content || "";
                        if (content) {
                            fullReply += content;
                            yield content;
                        }
                    } catch (e) {}
                }
            }
        }

        // 🌟 写入记忆前，对 AI 刚说的话做二次脱敏，物理防幻觉
        let cleanReply = fullReply.replace(/[*#`~]/g, '').replace(/https?:\/\/[^\s]+/gi, '');

        if (appendLinksText) {
            yield appendLinksText;
        }

        userMemory.chatContext.push({ role: 'user', content: userMessage });
        // 保存到记忆的对话是极其干净的，不含任何链接信息
        userMemory.chatContext.push({ role: 'assistant', content: cleanReply });

        compressMemoryIfNeeded(userId).catch(console.error);

    } catch (error) {
        console.error(`❌ [${userId}] AI 聊天请求失败:`, error.message);
        yield "哥们儿，我这边的信号刚才卡了一下，能再跟我说一次吗？";
    }
}

async function chatWithAI(userId, userMessage) {
    let fullResponse = "";
    const stream = chatWithAIStream(userId, userMessage);
    for await (const chunk of stream) {
        fullResponse += chunk;
    }
    return fullResponse;
}

module.exports = {
    recordPlayHistory,
    getRecommendations,
    chatWithAI,
    chatWithAIStream,
    decryptToken
};
