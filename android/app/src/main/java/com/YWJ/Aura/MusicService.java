package com.YWJ.Aura;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Color;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.support.v4.media.MediaMetadataCompat;
import android.support.v4.media.session.MediaSessionCompat;
import android.support.v4.media.session.PlaybackStateCompat;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.annotation.OptIn;
import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

import com.danikula.videocache.HttpProxyCacheServer;

import androidx.media3.common.AudioAttributes;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.Player;
import androidx.media3.common.audio.AudioProcessor;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.datasource.DefaultDataSource;
import androidx.media3.exoplayer.DefaultRenderersFactory;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.audio.AudioSink;
import androidx.media3.exoplayer.audio.DefaultAudioSink;
import androidx.media3.exoplayer.source.MediaSource;
import androidx.media3.exoplayer.source.ProgressiveMediaSource;

import java.io.BufferedInputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

@OptIn(markerClass = UnstableApi.class)
@SuppressWarnings("deprecation")
public class MusicService extends Service {

    private static final String CHANNEL_ID = "AuraMusic_Engine_Native";
    private static final String TAG = "AuraMusicService";

    private MediaSessionCompat mediaSession;
    private ExoPlayer exoPlayer;
    private NativeAuraProcessor dspProcessor;

    private final Handler progressHandler = new Handler(Looper.getMainLooper());
    private Runnable progressTask;

    private boolean isPlaying = false;
    private boolean userPaused = false;
    private String currentTitle = "Aura 音乐";
    private String currentArtist = "让声音更有温度";
    private Bitmap currentCoverBitmap = null;

    private final ExecutorService executorService = Executors.newSingleThreadExecutor();
    private final ExecutorService cacheExecutor = Executors.newSingleThreadExecutor();
    private Future<?> cachePrefetchTask;
    private volatile boolean cachePrefetchActive = false;
    private int cachePrefetchGeneration = 0;
    private int playbackState = Player.STATE_IDLE;
    private PowerManager.WakeLock wakeLock;
    private WifiManager.WifiLock wifiLock;

    private AudioManager audioManager;
    private AudioFocusRequest audioFocusRequest;
    private boolean shouldResumeAfterFocusLoss = false;
    private final Handler focusHandler = new Handler(Looper.getMainLooper());

    private boolean isScreenOff = false;

    private final AudioManager.OnAudioFocusChangeListener audioFocusChangeListener = focusChange -> {
        switch (focusChange) {
            case AudioManager.AUDIOFOCUS_GAIN -> {
                shouldResumeAfterFocusLoss = false;
                if (exoPlayer != null) {
                    exoPlayer.setVolume(1.0f);
                    if (!userPaused && !exoPlayer.isPlaying()) {
                        exoPlayer.play();
                    }
                }
            }

            case AudioManager.AUDIOFOCUS_LOSS -> {
                // 被系统判定为长时间失去焦点时，部分 Android 12+ 设备会强制淡出或静音。
                // 这里不主动 stop，只记录状态并尝试延迟恢复。不能保证压过所有系统策略。
                shouldResumeAfterFocusLoss = exoPlayer != null && exoPlayer.isPlaying();
                scheduleAudioFocusRegain();
            }

            case AudioManager.AUDIOFOCUS_LOSS_TRANSIENT,
                    AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> {
                // Aura 作为主音乐播放器，不主动 duck、不主动 pause。
                if (exoPlayer != null) {
                    exoPlayer.setVolume(1.0f);
                }
                shouldResumeAfterFocusLoss = !userPaused;
                scheduleAudioFocusRegain();
            }

            default -> {
            }
        }
    };

    private final BroadcastReceiver screenReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            String action = safeAction(intent);
            if (Intent.ACTION_SCREEN_OFF.equals(action)) {
                isScreenOff = true;
                if (dspProcessor != null) {
                    dspProcessor.setScreenOff(true);
                }
                requestAudioFocus();
                handleLocks();
            } else if (Intent.ACTION_SCREEN_ON.equals(action) || Intent.ACTION_USER_PRESENT.equals(action)) {
                isScreenOff = false;
                if (dspProcessor != null) {
                    dspProcessor.setScreenOff(false);
                }
                requestAudioFocus();
                handleLocks();
            }
        }
    };

    private final BroadcastReceiver controlReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            switch (safeAction(intent)) {
                case "com.YWJ.Aura.SVC_TOGGLE" -> {
                    if (isPlaying) {
                        pauseAudio();
                    } else {
                        resumeAudio();
                    }
                }

                case "com.YWJ.Aura.SVC_NEXT" -> sendToJS("com.YWJ.Aura.NEXT");

                case "com.YWJ.Aura.SVC_PREV" -> sendToJS("com.YWJ.Aura.PREV");

                default -> {
                }
            }
        }
    };

    @Override
    public void onCreate() {
        super.onCreate();

        audioManager = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
        createNotificationChannel();
        initMediaSession();
        initLocks();
        registerReceivers();
        initExoPlayer();
        updateNotification();
    }

    private void initMediaSession() {
        mediaSession = new MediaSessionCompat(this, "AuraMediaSession");

        Intent intent = new Intent(this, MainActivity.class);
        PendingIntent sessionPendingIntent = PendingIntent.getActivity(
                this,
                0,
                intent,
                PendingIntent.FLAG_IMMUTABLE
        );

        mediaSession.setSessionActivity(sessionPendingIntent);
        mediaSession.setActive(true);

        mediaSession.setCallback(new MediaSessionCompat.Callback() {
            @Override
            public void onPlay() {
                resumeAudio();
            }

            @Override
            public void onPause() {
                pauseAudio();
            }

            @Override
            public void onSkipToNext() {
                sendToJS("com.YWJ.Aura.NEXT");
            }

            @Override
            public void onSkipToPrevious() {
                sendToJS("com.YWJ.Aura.PREV");
            }

            @Override
            public void onStop() {
                pauseAudio();
            }
        });
    }

    private void initLocks() {
        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        if (pm != null) {
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "AuraMusic::NativeWakeLock");
            wakeLock.setReferenceCounted(false);
        }

        WifiManager wm = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
        if (wm != null) {
            wifiLock = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "AuraMusic::NativeWifiLock");
            wifiLock.setReferenceCounted(false);
        }
    }

    private void registerReceivers() {
        IntentFilter controlFilter = new IntentFilter();
        controlFilter.addAction("com.YWJ.Aura.SVC_TOGGLE");
        controlFilter.addAction("com.YWJ.Aura.SVC_NEXT");
        controlFilter.addAction("com.YWJ.Aura.SVC_PREV");
        ContextCompat.registerReceiver(this, controlReceiver, controlFilter, ContextCompat.RECEIVER_NOT_EXPORTED);

        IntentFilter screenFilter = new IntentFilter();
        screenFilter.addAction(Intent.ACTION_SCREEN_OFF);
        screenFilter.addAction(Intent.ACTION_SCREEN_ON);
        screenFilter.addAction(Intent.ACTION_USER_PRESENT);
        ContextCompat.registerReceiver(this, screenReceiver, screenFilter, ContextCompat.RECEIVER_NOT_EXPORTED);
    }

    private void initExoPlayer() {
        dspProcessor = new NativeAuraProcessor();

        DefaultRenderersFactory renderersFactory = new DefaultRenderersFactory(this) {
            @NonNull
            @Override
            protected AudioSink buildAudioSink(
                    @NonNull Context context,
                    boolean enableFloatOutput,
                    boolean enableAudioTrackPlaybackParams
            ) {
                return new DefaultAudioSink.Builder(context)
                        // 关键：不要强制 float 输出。PCM16 路径更稳，Native 层内部再转 float 处理。
                        .setEnableFloatOutput(false)
                        .setAudioProcessors(new AudioProcessor[]{dspProcessor})
                        .build();
            }
        };

        AudioAttributes audioAttributes = new AudioAttributes.Builder()
                .setUsage(C.USAGE_MEDIA)
                .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
                .build();

        exoPlayer = new ExoPlayer.Builder(this, renderersFactory)
                // false：禁止 ExoPlayer 自动处理 AudioFocus，避免被系统焦点回调直接 pause。
                // AudioFocus 由本 Service 自己管理。
                .setAudioAttributes(audioAttributes, false)
                .setHandleAudioBecomingNoisy(true)
                .build();

        exoPlayer.setWakeMode(C.WAKE_MODE_NETWORK);

        exoPlayer.addListener(new Player.Listener() {
            @Override
            public void onPlaybackStateChanged(int newPlaybackState) {
                playbackState = newPlaybackState;
                handleLocks();
                if (newPlaybackState == Player.STATE_ENDED) {
                    isPlaying = false;
                    updateNotification();
                    sendToJS("com.YWJ.Aura.ENDED");
                }
            }

            @Override
            public void onIsPlayingChanged(boolean playing) {
                isPlaying = playing;
                updateNotification();
                syncStateToJS();
                handleLocks();

                if (playing) {
                    userPaused = false;
                    startProgressReporting();
                }
            }
        });
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        androidx.media.session.MediaButtonReceiver.handleIntent(mediaSession, intent);

        switch (safeAction(intent)) {
            case "PLAY_URL" -> {
                currentTitle = safeText(intent == null ? null : intent.getStringExtra("title"), "Aura 音乐");
                currentArtist = safeText(intent == null ? null : intent.getStringExtra("artist"), "让声音更有温度");
                currentCoverBitmap = null;
                userPaused = false;

                requestAudioFocus();
                updateNotification();

                playUrl(
                        intent == null ? null : intent.getStringExtra("url"),
                        intent == null ? null : intent.getStringExtra("legacy_cache_url")
                );
                fetchCoverBitmap(intent == null ? null : intent.getStringExtra("cover_url"));
            }

            case "PAUSE" -> pauseAudio();

            case "RESUME" -> resumeAudio();

            case "SEEK" -> {
                if (exoPlayer != null && intent != null) {
                    exoPlayer.seekTo(intent.getIntExtra("position", 0));
                }
            }

            case "SET_EFFECT" -> {
                if (dspProcessor != null && intent != null) {
                    dspProcessor.setMode(intent.getStringExtra("effect_type"));
                    dspProcessor.setScreenOff(isScreenOff);
                }
            }

            default -> {
            }
        }

        return START_STICKY;
    }

    private boolean requestAudioFocus() {
        if (audioManager == null) {
            return true;
        }

        int result;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            android.media.AudioAttributes attrs = new android.media.AudioAttributes.Builder()
                    .setUsage(android.media.AudioAttributes.USAGE_MEDIA)
                    .setContentType(android.media.AudioAttributes.CONTENT_TYPE_MUSIC)
                    .build();

            audioFocusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                    .setAudioAttributes(attrs)
                    .setAcceptsDelayedFocusGain(false)
                    .setWillPauseWhenDucked(false)
                    .setOnAudioFocusChangeListener(audioFocusChangeListener, new Handler(Looper.getMainLooper()))
                    .build();

            result = audioManager.requestAudioFocus(audioFocusRequest);
        } else {
            result = audioManager.requestAudioFocus(
                    audioFocusChangeListener,
                    AudioManager.STREAM_MUSIC,
                    AudioManager.AUDIOFOCUS_GAIN
            );
        }

        return result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED;
    }

    private void scheduleAudioFocusRegain() {
        focusHandler.removeCallbacksAndMessages(null);
        focusHandler.postDelayed(() -> {
            boolean granted = requestAudioFocus();
            if (granted && shouldResumeAfterFocusLoss && !userPaused && exoPlayer != null && !exoPlayer.isPlaying()) {
                exoPlayer.setVolume(1.0f);
                exoPlayer.play();
            }
        }, 650);
    }

    private void abandonAudioFocus() {
        if (audioManager == null) {
            return;
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && audioFocusRequest != null) {
            audioManager.abandonAudioFocusRequest(audioFocusRequest);
        } else {
            audioManager.abandonAudioFocus(audioFocusChangeListener);
        }
    }

    private static String safeAction(Intent intent) {
        String action = intent == null ? null : intent.getAction();
        return action == null ? "" : action;
    }

    private String safeText(String value, String fallback) {
        return value == null || value.trim().isEmpty() ? fallback : value;
    }

    private void playUrl(String url, String legacyCacheUrl) {
        if (url == null || url.trim().isEmpty()) {
            sendToJS("com.YWJ.Aura.ERROR");
            return;
        }

        try {
            HttpProxyCacheServer proxy = AuraApplication.getProxy(this);
            String cacheUrl = AuraApplication.resolveCacheUrl(this, url, legacyCacheUrl);
            boolean isFullyCached = proxy.isCached(cacheUrl);
            String proxyUrl = proxy.getProxyUrl(cacheUrl);
            Log.i(TAG, "Audio source=" + (isFullyCached ? "LOCAL_CACHE" : "CLOUD_FILL_CACHE"));

            DefaultDataSource.Factory dataSourceFactory = new DefaultDataSource.Factory(this);
            MediaSource mediaSource = new ProgressiveMediaSource.Factory(dataSourceFactory)
                    .createMediaSource(MediaItem.fromUri(proxyUrl));

            exoPlayer.setMediaSource(mediaSource);
            exoPlayer.prepare();
            exoPlayer.play();
            if (!isFullyCached) {
                startCachePrefetch(proxy, cacheUrl, proxyUrl);
            } else {
                cancelCachePrefetch();
            }
        } catch (Exception e) {
            Log.e(TAG, "播放音频失败", e);
            sendToJS("com.YWJ.Aura.ERROR");
        }
    }

    private void startCachePrefetch(HttpProxyCacheServer proxy, String cacheUrl, String proxyUrl) {
        cancelCachePrefetch();
        final int generation = ++cachePrefetchGeneration;
        cachePrefetchActive = true;
        handleLocks();
        updateNotification();

        cachePrefetchTask = cacheExecutor.submit(() -> {
            HttpURLConnection connection = null;
            long downloadedBytes = 0L;
            try {
                connection = (HttpURLConnection) new URL(proxyUrl).openConnection();
                connection.setConnectTimeout(15000);
                connection.setReadTimeout(30000);
                connection.setRequestProperty("Connection", "close");
                connection.connect();

                byte[] buffer = new byte[128 * 1024];
                try (InputStream input = new BufferedInputStream(connection.getInputStream(), buffer.length)) {
                    int read;
                    while (!Thread.currentThread().isInterrupted() && (read = input.read(buffer)) != -1) {
                        downloadedBytes += read;
                    }
                }

                if (!Thread.currentThread().isInterrupted()) {
                    Log.i(TAG, "Cache prefetch finished bytes=" + downloadedBytes
                            + " complete=" + proxy.isCached(cacheUrl));
                }
            } catch (Exception error) {
                if (!Thread.currentThread().isInterrupted()) {
                    Log.w(TAG, "Cache prefetch stopped bytes=" + downloadedBytes, error);
                }
            } finally {
                if (connection != null) {
                    connection.disconnect();
                }
                progressHandler.post(() -> {
                    if (generation == cachePrefetchGeneration) {
                        cachePrefetchTask = null;
                        cachePrefetchActive = false;
                        handleLocks();
                        updateNotification();
                    }
                });
            }
        });
    }

    private void cancelCachePrefetch() {
        cachePrefetchGeneration += 1;
        if (cachePrefetchTask != null) {
            cachePrefetchTask.cancel(true);
            cachePrefetchTask = null;
        }
        cachePrefetchActive = false;
        handleLocks();
    }

    private void fetchCoverBitmap(String urlString) {
        if (urlString == null || urlString.trim().isEmpty()) {
            return;
        }

        executorService.execute(() -> {
            try {
                URL url = new URL(urlString);
                HttpURLConnection connection = (HttpURLConnection) url.openConnection();
                connection.setConnectTimeout(3000);
                connection.setReadTimeout(3000);
                connection.connect();

                InputStream input = connection.getInputStream();
                Bitmap bitmap = BitmapFactory.decodeStream(input);

                if (bitmap != null) {
                    int maxDim = 800;
                    int width = bitmap.getWidth();
                    int height = bitmap.getHeight();
                    int maxSide = Math.max(width, height);

                    if (maxSide > maxDim) {
                        float ratio = (float) maxDim / maxSide;
                        int targetWidth = Math.max(1, Math.round(width * ratio));
                        int targetHeight = Math.max(1, Math.round(height * ratio));
                        bitmap = Bitmap.createScaledBitmap(bitmap, targetWidth, targetHeight, true);
                    }

                    final Bitmap finalBitmap = bitmap;
                    new Handler(Looper.getMainLooper()).post(() -> {
                        currentCoverBitmap = finalBitmap;
                        updateNotification();
                    });
                }
            } catch (Exception e) {
                Log.e(TAG, "加载封面图失败", e);
            }
        });
    }

    private void pauseAudio() {
        userPaused = true;
        shouldResumeAfterFocusLoss = false;
        if (exoPlayer != null && exoPlayer.isPlaying()) {
            exoPlayer.pause();
        }
        updateNotification();
    }

    private void resumeAudio() {
        userPaused = false;
        requestAudioFocus();
        if (exoPlayer != null && !exoPlayer.isPlaying()) {
            exoPlayer.play();
        }
        updateNotification();
    }

    private void startProgressReporting() {
        progressHandler.removeCallbacks(progressTask);

        progressTask = new Runnable() {
            @Override
            public void run() {
                if (exoPlayer != null && isPlaying) {
                    long durationLong = exoPlayer.getDuration();
                    int duration = durationLong <= 0 ? 0 : (int) Math.min(durationLong, Integer.MAX_VALUE);
                    int current = (int) Math.min(exoPlayer.getCurrentPosition(), Integer.MAX_VALUE);

                    Intent intent = new Intent("com.YWJ.Aura.PROGRESS").setPackage(getPackageName());
                    intent.putExtra("current", current);
                    intent.putExtra("duration", duration);
                    sendBroadcast(intent);

                    progressHandler.postDelayed(this, 500);
                }
            }
        };

        progressHandler.post(progressTask);
    }

    private void handleLocks() {
        boolean needsNetworkWake = isPlaying
                || playbackState == Player.STATE_BUFFERING
                || cachePrefetchActive;
        if (needsNetworkWake) {
            if (wakeLock != null && !wakeLock.isHeld()) {
                // 不再设置 10 分钟超时。播放时一直持有，暂停/销毁时释放。
                wakeLock.acquire();
            }

            if (wifiLock != null && !wifiLock.isHeld()) {
                wifiLock.acquire();
            }
        } else {
            if (wakeLock != null && wakeLock.isHeld()) {
                wakeLock.release();
            }

            if (wifiLock != null && wifiLock.isHeld()) {
                wifiLock.release();
            }
        }
    }

    private void sendToJS(String action) {
        sendBroadcast(new Intent(action).setPackage(getPackageName()));
    }

    private void syncStateToJS() {
        Intent intent = new Intent("com.YWJ.Aura.SYNC_PLAY_STATE").setPackage(getPackageName());
        intent.putExtra("isPlaying", isPlaying);
        sendBroadcast(intent);
    }

    private Bitmap getWhiteBgIcon() {
        try {
            Bitmap original = BitmapFactory.decodeResource(getResources(), R.drawable.ic_aura_logo);
            if (original == null) {
                return BitmapFactory.decodeResource(getResources(), R.mipmap.ic_launcher);
            }

            Bitmap bitmap = Bitmap.createBitmap(
                    original.getWidth(),
                    original.getHeight(),
                    Bitmap.Config.ARGB_8888
            );

            Canvas canvas = new Canvas(bitmap);
            canvas.drawColor(Color.WHITE);
            canvas.drawBitmap(original, 0, 0, null);

            return bitmap;
        } catch (Exception e) {
            Log.e(TAG, "生成兜底图标失败", e);
            return null;
        }
    }

    @android.annotation.SuppressLint("ForegroundServiceType")
    private void updateNotification() {
        if (mediaSession == null) {
            return;
        }

        long actions = PlaybackStateCompat.ACTION_PLAY
                | PlaybackStateCompat.ACTION_PAUSE
                | PlaybackStateCompat.ACTION_SKIP_TO_NEXT
                | PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS;

        long position = exoPlayer != null ? exoPlayer.getCurrentPosition() : 0;

        PlaybackStateCompat.Builder stateBuilder = new PlaybackStateCompat.Builder()
                .setActions(actions)
                .setState(
                        isPlaying ? PlaybackStateCompat.STATE_PLAYING : PlaybackStateCompat.STATE_PAUSED,
                        position,
                        1.0f
                );

        mediaSession.setPlaybackState(stateBuilder.build());

        Bitmap coverToDisplay = currentCoverBitmap != null ? currentCoverBitmap : getWhiteBgIcon();

        mediaSession.setMetadata(new MediaMetadataCompat.Builder()
                .putString(MediaMetadataCompat.METADATA_KEY_TITLE, currentTitle)
                .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, currentArtist)
                .putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, coverToDisplay)
                .build());

        Intent notificationIntent = new Intent(this, MainActivity.class);
        PendingIntent pendingIntent = PendingIntent.getActivity(
                this,
                0,
                notificationIntent,
                PendingIntent.FLAG_IMMUTABLE
        );

        PendingIntent toggleIntent = PendingIntent.getBroadcast(
                this,
                1,
                new Intent("com.YWJ.Aura.SVC_TOGGLE").setPackage(getPackageName()),
                PendingIntent.FLAG_IMMUTABLE
        );

        PendingIntent nextIntent = PendingIntent.getBroadcast(
                this,
                2,
                new Intent("com.YWJ.Aura.SVC_NEXT").setPackage(getPackageName()),
                PendingIntent.FLAG_IMMUTABLE
        );

        PendingIntent prevIntent = PendingIntent.getBroadcast(
                this,
                3,
                new Intent("com.YWJ.Aura.SVC_PREV").setPackage(getPackageName()),
                PendingIntent.FLAG_IMMUTABLE
        );

        Notification notification = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setSmallIcon(R.mipmap.ic_launcher)
                .setLargeIcon(coverToDisplay)
                .setContentTitle(currentTitle)
                .setContentText(currentArtist)
                .setContentIntent(pendingIntent)
                .addAction(new NotificationCompat.Action.Builder(
                        R.drawable.ic_custom_prev,
                        "Prev",
                        prevIntent
                ).build())
                .addAction(new NotificationCompat.Action.Builder(
                        isPlaying ? R.drawable.ic_custom_pause : R.drawable.ic_custom_play,
                        "Toggle",
                        toggleIntent
                ).build())
                .addAction(new NotificationCompat.Action.Builder(
                        R.drawable.ic_custom_next,
                        "Next",
                        nextIntent
                ).build())
                .setStyle(new androidx.media.app.NotificationCompat.MediaStyle()
                        .setShowActionsInCompactView(0, 1, 2)
                        .setMediaSession(mediaSession.getSessionToken()))
                .setPriority(NotificationCompat.PRIORITY_MAX)
                .setOngoing(isPlaying || cachePrefetchActive)
                .build();

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            int serviceType = ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK;
            if (cachePrefetchActive || playbackState == Player.STATE_BUFFERING) {
                serviceType |= ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC;
            }
            startForeground(1, notification, serviceType);
        } else {
            startForeground(1, notification);
        }
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }

        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID,
                    "Aura Native 音频引擎",
                    NotificationManager.IMPORTANCE_DEFAULT
            );
            manager.createNotificationChannel(channel);
        }
    }

    @Override
    public void onDestroy() {
        super.onDestroy();

        progressHandler.removeCallbacksAndMessages(null);
        focusHandler.removeCallbacksAndMessages(null);
        cancelCachePrefetch();
        executorService.shutdownNow();
        cacheExecutor.shutdownNow();

        if (exoPlayer != null) {
            exoPlayer.release();
            exoPlayer = null;
        }

        if (dspProcessor != null) {
            dspProcessor.releaseNative();
            dspProcessor = null;
        }

        if (wakeLock != null && wakeLock.isHeld()) {
            wakeLock.release();
        }

        if (wifiLock != null && wifiLock.isHeld()) {
            wifiLock.release();
        }

        abandonAudioFocus();

        try {
            unregisterReceiver(controlReceiver);
        } catch (Exception ignored) {
        }

        try {
            unregisterReceiver(screenReceiver);
        } catch (Exception ignored) {
        }

        if (mediaSession != null) {
            mediaSession.release();
            mediaSession = null;
        }
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private static class NativeAuraProcessor implements AudioProcessor {

        private static final String MODE_NORMAL = "normal";
        private static final String MODE_3D = "3d";
        private static final String MODE_HIFI = "hifi";
        private static final String MODE_VOCAL = "vocal";

        static {
            System.loadLibrary("aura_dsp");
        }

        private long nativeHandle = 0L;
        private volatile String requestedMode = MODE_NORMAL;
        private volatile boolean screenOff = false;

        private boolean active = false;
        private boolean inputEnded = false;
        private AudioFormat currentFormat = AudioFormat.NOT_SET;

        private ByteBuffer inputDirectBuffer = AudioProcessor.EMPTY_BUFFER;
        private ByteBuffer outputDirectBuffer = AudioProcessor.EMPTY_BUFFER;
        private ByteBuffer outputBuffer = AudioProcessor.EMPTY_BUFFER;

        NativeAuraProcessor() {
            nativeHandle = nativeCreate();
        }

        void setMode(String mode) {
            requestedMode = sanitizeMode(mode);
            if (nativeHandle != 0L) {
                nativeSetMode(nativeHandle, requestedMode);
            }
        }

        void setScreenOff(boolean value) {
            screenOff = value;
            if (nativeHandle != 0L) {
                nativeSetScreenOff(nativeHandle, value);
            }
        }

        void releaseNative() {
            if (nativeHandle != 0L) {
                nativeRelease(nativeHandle);
                nativeHandle = 0L;
            }
        }

        @NonNull
        @Override
        public AudioFormat configure(@NonNull AudioFormat inputAudioFormat) throws UnhandledAudioFormatException {
            boolean isSupportedEncoding = inputAudioFormat.encoding == C.ENCODING_PCM_16BIT
                    || inputAudioFormat.encoding == C.ENCODING_PCM_FLOAT;

            if (!isSupportedEncoding || inputAudioFormat.channelCount != 2) {
                throw new UnhandledAudioFormatException(inputAudioFormat);
            }

            currentFormat = inputAudioFormat;
            active = true;
            inputEnded = false;

            if (nativeHandle == 0L) {
                nativeHandle = nativeCreate();
            }

            nativeConfigure(
                    nativeHandle,
                    Math.max(8000, inputAudioFormat.sampleRate),
                    inputAudioFormat.channelCount,
                    inputAudioFormat.encoding
            );
            nativeSetMode(nativeHandle, requestedMode);
            nativeSetScreenOff(nativeHandle, screenOff);

            return inputAudioFormat;
        }

        @Override
        public boolean isActive() {
            return active;
        }

        @Override
        public void queueInput(@NonNull ByteBuffer inputBuffer) {
            int inputBytes = inputBuffer.remaining();
            if (inputBytes <= 0) {
                outputBuffer = AudioProcessor.EMPTY_BUFFER;
                return;
            }

            boolean isFloat = currentFormat.encoding == C.ENCODING_PCM_FLOAT;
            int bytesPerSample = isFloat ? 4 : 2;
            int frameSize = bytesPerSample * 2;
            int frameCount = inputBytes / frameSize;
            int outputBytes = frameCount * frameSize;

            if (frameCount <= 0 || nativeHandle == 0L) {
                inputBuffer.position(inputBuffer.limit());
                outputBuffer = AudioProcessor.EMPTY_BUFFER;
                return;
            }

            ensureDirectInputBuffer(inputBytes);
            ensureDirectOutputBuffer(outputBytes);

            inputDirectBuffer.clear();
            ByteBuffer copied = inputBuffer.slice().order(ByteOrder.nativeOrder());
            inputDirectBuffer.put(copied);
            inputDirectBuffer.flip();
            inputBuffer.position(inputBuffer.limit());

            outputDirectBuffer.clear();
            int writtenBytes = nativeProcess(
                    nativeHandle,
                    inputDirectBuffer,
                    outputDirectBuffer,
                    frameCount,
                    isFloat
            );

            int safeWrittenBytes = Math.max(0, Math.min(writtenBytes, outputBytes));
            outputDirectBuffer.position(0);
            outputDirectBuffer.limit(safeWrittenBytes);
            outputBuffer = outputDirectBuffer;
        }

        private void ensureDirectInputBuffer(int requiredBytes) {
            if (inputDirectBuffer.capacity() < requiredBytes) {
                inputDirectBuffer = ByteBuffer.allocateDirect(requiredBytes).order(ByteOrder.nativeOrder());
            } else {
                inputDirectBuffer.clear();
            }
        }

        private void ensureDirectOutputBuffer(int requiredBytes) {
            if (outputDirectBuffer.capacity() < requiredBytes) {
                outputDirectBuffer = ByteBuffer.allocateDirect(requiredBytes).order(ByteOrder.nativeOrder());
            } else {
                outputDirectBuffer.clear();
            }
        }

        @Override
        public void queueEndOfStream() {
            inputEnded = true;
        }

        @NonNull
        @Override
        public ByteBuffer getOutput() {
            ByteBuffer output = outputBuffer;
            outputBuffer = AudioProcessor.EMPTY_BUFFER;
            return output;
        }

        @Override
        public boolean isEnded() {
            return inputEnded && outputBuffer == AudioProcessor.EMPTY_BUFFER;
        }

        @Override
        public void flush() {
            outputBuffer = AudioProcessor.EMPTY_BUFFER;
            inputEnded = false;
            if (nativeHandle != 0L) {
                nativeFlush(nativeHandle);
                nativeSetMode(nativeHandle, requestedMode);
                nativeSetScreenOff(nativeHandle, screenOff);
            }
        }

        @Override
        public void reset() {
            flush();
            currentFormat = AudioFormat.NOT_SET;
            active = false;
        }

        private static String sanitizeMode(String mode) {
            if (mode == null) {
                return MODE_NORMAL;
            }

            String normalized = mode.trim().toLowerCase(Locale.US);
            return switch (normalized) {
                case MODE_3D, "spatial", "surround", "game", "cinema3d" -> MODE_3D;
                case MODE_HIFI, "hi-fi", "lossless", "immersive", "dolby", "atmos", "cinema", "live" -> MODE_HIFI;
                case MODE_VOCAL, "voice", "vocal_only", "clean_vocal" -> MODE_VOCAL;
                default -> MODE_NORMAL;
            };
        }

        private static native long nativeCreate();

        private static native void nativeConfigure(long handle, int sampleRate, int channels, int encoding);

        private static native void nativeSetMode(long handle, String mode);

        private static native void nativeSetScreenOff(long handle, boolean screenOff);

        private static native int nativeProcess(long handle, ByteBuffer inputBuffer, ByteBuffer outputBuffer, int frameCount, boolean floatInput);

        private static native void nativeFlush(long handle);

        private static native void nativeRelease(long handle);
    }
}
