# Aura Mobile

Aura Mobile 是一个面向 Android 的混合式音乐播放器。项目使用 Vite 构建前端界面，通过 Capacitor 嵌入 Android WebView，并由原生 `MusicService`、Media3 ExoPlayer 和 C++ DSP 负责后台播放、媒体通知、音频焦点、缓存与音效处理。

仓库同时包含客户端与独立后端源码。后端负责音乐搜索、音频下载与缓存、封面代理、多源歌词聚合、账号收藏，以及基于 DeepSeek 的 AI 推荐与对话。

## 主要功能

### 音乐发现与搜索

- 提供“猜你喜欢”“每日推荐”“排行榜”三类推荐内容。
- 支持按歌曲名或歌手搜索全网音乐。
- 搜索结果显示封面、歌曲名、歌手和时长，点击即可加入当前队列并播放。
- 支持 AI 音乐助手，可以用自然语言描述想听的音乐。

### 播放体验

- 支持播放、暂停、上一首、下一首和拖动进度。
- 提供列表循环、单曲循环和随机播放三种模式。
- 支持播放队列查看、切歌和单项删除。
- 页面底部提供迷你播放器，点击后展开全屏播放器。
- Android 端使用前台音乐服务，界面退出或锁屏后仍可继续播放。
- 支持系统媒体通知、锁屏媒体控制、耳机/媒体按键和音频焦点处理。
- Android 端使用本地代理缓存音频，并兼容迁移旧版本缓存。

### 歌词

- 自动请求并解析 LRC 时间轴歌词。
- 当前歌词随播放进度自动高亮和滚动。
- 点击歌词可跳转到对应播放位置。
- 支持歌词时间偏移调整，每次调整 `0.5` 秒，范围为 `-10` 到 `+10` 秒。
- 支持唱片视图与全屏歌词视图切换。
- 歌词会缓存在本机，最多维护 100 条缓存记录。

### 收藏与账号同步

- 游客模式下，收藏保存在浏览器/WebView 的 `localStorage` 中。
- 支持账号注册、登录和退出。
- 注册时可以迁移本机收藏，也可以创建空收藏空间。
- 登录后可从云端加载收藏，并支持在收藏列表内搜索。
- 收藏同步采用串行队列，避免快速操作导致旧请求覆盖新数据。
- 同步完成后会重新读取云端数据进行一致性校验。
- 网络失败时保留本机收藏和待同步标记，恢复网络后自动重试。
- 退出登录前会先等待收藏同步，降低收藏丢失风险。

### 音效与个性化

- 提供标准、3D 环绕、全景 HiFi、纯净人声四种音效模式。
- Android 端通过 Media3 `AudioProcessor` 调用 C++ 原生 DSP 实现音频处理。
- 支持红、蓝、绿、紫、浅色和深色六套主题。
- 歌词字号可在 `18px` 到 `34px` 之间调整。
- 播放模式、主题、歌词字号、音效和登录状态均会在本机持久化。

## 前端界面

界面采用移动端优先的单页布局，并兼顾较宽屏幕。整体风格接近现代移动音乐应用，以圆角面板、半透明播放器层、封面模糊背景和主题强调色构成。

### 发现页

顶部有三个标签：

1. **推荐**：顶部横向展示“猜你喜欢”“每日推荐”“排行榜”卡片，下方显示对应歌曲列表。
2. **AI 助手**：聊天式界面，上方显示对话记录，下方输入听歌需求。
3. **搜索**：输入歌曲名或歌手后展示带封面、标题、歌手和时长的搜索结果。

### 我的页面

- 展示本机或当前账号的收藏歌曲。
- 顶部账号按钮用于注册、登录、退出和查看同步状态。
- 提供收藏列表内搜索。
- 每首收藏可以直接播放或删除。

### 播放器

- 非全屏状态下，底部迷你播放器显示封面、歌名、歌手及上一首、播放/暂停、下一首按钮。
- 展开后显示大尺寸唱片封面、动态模糊背景、歌曲信息、播放进度和完整控制栏。
- 右侧或下方区域显示同步歌词，布局会根据屏幕宽度自动调整。
- 顶部提供收藏、播放队列、设置和收起按钮。
- 队列以侧边抽屉呈现，设置和账号操作使用模态窗口呈现。
- 交互元素包含 ARIA 标签、键盘进度控制、焦点管理和状态提示。

底部主导航只有两个入口：

- **发现**：推荐、AI 助手与搜索。
- **我的**：收藏和账号管理。

## 技术栈

| 层级 | 技术 |
| --- | --- |
| 前端 | HTML、CSS、原生 JavaScript ES Modules |
| 构建工具 | Vite 5 |
| 混合应用 | Capacitor 8 |
| Android | Java、AndroidX、Gradle |
| 播放引擎 | AndroidX Media3 ExoPlayer |
| 后台控制 | Foreground Service、MediaSession、MediaStyle Notification |
| 音频处理 | Media3 AudioProcessor、C++17、JNI、CMake |
| 音频缓存 | AndroidVideoCache |
| 本地状态 | localStorage |
| 后端 | Node.js 20、Express 5 |
| 音源处理 | yt-dlp、Deno、YouTube.js |
| AI | DeepSeek Chat Completions API |

## 项目结构

```text
Aura-Mobile/
├─ src/
│  ├─ index.html          # 页面结构
│  ├─ style.css           # 响应式界面和主题样式
│  ├─ script.js           # 前端入口
│  ├─ store.js            # DOM 引用、常量和全局状态
│  ├─ services.js         # 搜索、AI、账号、收藏与歌词服务
│  ├─ audio.js            # 播放、进度、队列和原生桥接
│  ├─ ui.js               # 页面、播放器、主题和弹窗交互
│  └─ utils.js            # LRC 解析、文本清理和通用组件
├─ android/
│  └─ app/src/main/
│     ├─ java/com/YWJ/Aura/
│     │  ├─ MainActivity.java    # Capacitor 与 JavaScript 原生桥
│     │  ├─ MusicService.java    # 后台播放与媒体通知
│     │  └─ AuraApplication.java # 音频缓存初始化
│     └─ cpp/
│        └─ aura_native_dsp.cpp  # 原生 DSP
├─ tools/                 # 收藏缓存检查和修复脚本
├─ backend/
│  ├─ server.js           # API、音频缓存、歌词聚合和账号收藏
│  ├─ ai_agent.js         # AI 推荐、对话、意图识别和用户记忆
│  ├─ test/               # 音频流与缓存测试
│  ├─ ops/                # Linux 网络参数示例
│  └─ music-backend.service # systemd 服务示例
├─ capacitor.config.json
├─ vite.config.js
└─ package.json
```

## 环境要求

### Web 开发

- Node.js 18 或更高版本
- npm

### Android 开发

- Windows 11 或其他受 Android Studio 支持的系统
- Android Studio
- JDK 21
- Android SDK 36
- Android NDK `26.3.11579264`
- CMake `3.22.1`

应用最低支持 Android API 24，目标 API 为 36。

### 后端服务

- Node.js 20 或更高版本
- Python 3.11
- `yt-dlp`
- Deno（作为 `yt-dlp` 的 JavaScript 运行时）
- DeepSeek API Key（仅 AI 功能需要）

## 本地运行前端

安装依赖：

```powershell
npm install
```

启动 Vite 开发服务器：

```powershell
npm run dev
```

终端会显示本地访问地址。前端需要能够访问 Aura 后端，否则搜索、推荐、AI、歌词和账号同步功能不会返回数据。

生成普通 Web 构建：

```powershell
npm run build
```

根据当前 `vite.config.js`，该命令会把产物写入仓库根目录的 `dist/`。

## 构建 Android 应用

`capacitor.config.json` 当前将 Android Web 资源目录配置为 `src/dist`。更新 Android 内嵌页面时，先将 Vite 产物构建到该目录：

```powershell
npx vite build src --outDir src/dist
npx cap copy android
```

构建 Debug APK：

```powershell
Set-Location android
.\gradlew.bat assembleDebug
```

APK 默认生成在：

```text
android/app/build/outputs/apk/debug/app-debug.apk
```

也可以在 Android Studio 中打开 `android/` 目录后运行应用。

## 运行后端

进入后端目录并安装依赖：

```powershell
Set-Location backend
npm ci
```

以 `backend/.env.example` 为模板设置运行环境变量。PowerShell 示例：

```powershell
$env:PORT = '3000'
$env:EXTERNAL_URL = 'https://api.example.com'
$env:DEEPSEEK_API_KEY = '<YOUR_DEEPSEEK_API_KEY>'
$env:URL_SECRET = '<A_LONG_RANDOM_SECRET>'
$env:YT_DLP_PYTHON = 'python3.11'
$env:YT_DLP_DENO = '<PATH_TO_DENO>'
$env:YT_DLP_COOKIES_FILE = '<PATH_TO_YOUTUBE_COOKIES>'
$env:AUDIO_CACHE_DIR = '<PATH_TO_AUDIO_CACHE>'
npm start
```

其中 `URL_SECRET` 用于生成 AI 推荐音频的加密短链接。未设置 `DEEPSEEK_API_KEY` 或 `URL_SECRET` 时，普通搜索、音频和歌词接口仍可运行，AI 模块不会启用。

运行后端测试：

```powershell
Set-Location backend
npm test
```

后端生产部署和音频缓存测试以 Linux 为目标。当前 `audio-stream.test.js` 会创建无扩展名的假 `yt-dlp` 可执行文件，因此完整测试套件应在 Linux 或 WSL 中运行；直接在 Windows 执行时，缓存未命中用例会因 `spawn ... ENOENT` 失败，其余不依赖该夹具的测试仍可运行。

`backend/music-backend.service`、`backend/yt-dlp-update.crontab` 和 `backend/ops/` 提供 Linux 部署与网络参数示例，使用前需要替换其中的绝对路径。

## 后端 API

默认 API 地址定义在 `src/store.js`：

```js
export const API_BASE = 'http://47.77.230.218:3000/api';
```

主要接口如下：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/search?q=关键词` | 搜索歌曲 |
| GET | `/stream/:videoId` | 获取或代理音频流 |
| GET | `/stream?url=...` | 兼容旧版音频流地址 |
| GET | `/image?url=...` | 代理歌曲封面 |
| GET | `/lyrics?...` | 获取 LRC 歌词 |
| GET | `/ai/recommend?userId=...` | 获取个性化、每日和热门推荐 |
| POST | `/ai/chat` | AI 音乐对话 |
| POST | `/ai/history` | 写入或更新 AI 使用的播放历史 |
| POST | `/user/auth` | 查询账号、注册/登录校验和读取收藏 |
| POST | `/user/favorites` | 保存收藏快照 |

音频接口支持 `GET`、`HEAD` 和 HTTP Range 请求。缓存未命中时，服务端通过 `yt-dlp` 下载到临时文件，完成后原子发布到缓存目录；相同音频的并发请求会复用同一个下载任务。

歌词接口会聚合 LRCLIB、网易云音乐、QQ 音乐、酷狗和酷我等来源，并根据歌曲名、歌手、时长与同步时间标签选择候选结果。

如需使用自己的后端，请修改 `src/store.js` 中的 `API_BASE`，并同步调整 Android 的网络安全配置。当前客户端默认允许访问明文 HTTP API；正式部署建议使用 HTTPS。

## 数据与权限说明

- Android 应用需要网络、通知、前台媒体服务、唤醒锁和音频设置权限。
- 首次运行可能请求通知权限和忽略电池优化，以维持后台播放。
- 当前账号名和密码保存在 WebView 的 `localStorage` 中，适合当前客户端实现；面向公开环境部署时应改用安全令牌和系统级安全存储。
- 音频、封面、歌词和 AI 能力依赖后端服务及对应内容源的可用性。
- 后端运行数据、账号收藏文件、AI 用户记忆、音频缓存、Cookies 和 `.env` 均已被后端忽略规则排除，不应提交到 Git。

## 常用命令

```powershell
npm run dev       # 启动前端开发服务器
npm run build     # 构建普通 Web 产物到 dist/
npx cap copy android

Set-Location android
.\gradlew.bat assembleDebug

Set-Location ..\backend
npm ci
npm test
npm start
```

## License

项目在 `package.json` 中声明为 ISC License。
