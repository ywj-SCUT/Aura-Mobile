package com.YWJ.Aura;

import android.annotation.SuppressLint;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.PowerManager;
import android.provider.Settings;
import android.webkit.WebSettings;
import android.webkit.WebView;
import androidx.core.content.ContextCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    private ServiceEventReceiver receiver;

    @SuppressLint("SetJavaScriptEnabled") // 🌟 告诉 IDE：这是 Capacitor 混合应用，必须开启 JS，压制 XSS 警告
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // 🌟 移除了冗余的 KITKAT 版本检查（因为最低 API 已 >= 24）
        WebView.setWebContentsDebuggingEnabled(true);

        WebView webView = bridge.getWebView();
        if (webView != null) {
            WebSettings settings = webView.getSettings();

            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
            settings.setJavaScriptEnabled(true);
            settings.setDomStorageEnabled(true);
            settings.setDatabaseEnabled(true);

            settings.setCacheMode(WebSettings.LOAD_DEFAULT);
            settings.setAllowFileAccess(true);

            webView.addJavascriptInterface(new Object() {

                @SuppressWarnings("unused")
                @android.webkit.JavascriptInterface
                public void playAudio(String url, String title, String artist, String coverUrl) {
                    Intent intent = new Intent(MainActivity.this, MusicService.class);
                    intent.setAction("PLAY_URL");
                    intent.putExtra("url", url);
                    intent.putExtra("title", title);
                    intent.putExtra("artist", artist);
                    intent.putExtra("cover_url", coverUrl);
                    startServiceSafe(intent);
                }

                @SuppressWarnings("unused")
                @android.webkit.JavascriptInterface
                public void playAudioV2(String url, String title, String artist, String coverUrl, String legacyCacheUrl) {
                    Intent intent = new Intent(MainActivity.this, MusicService.class);
                    intent.setAction("PLAY_URL");
                    intent.putExtra("url", url);
                    intent.putExtra("title", title);
                    intent.putExtra("artist", artist);
                    intent.putExtra("cover_url", coverUrl);
                    intent.putExtra("legacy_cache_url", legacyCacheUrl);
                    startServiceSafe(intent);
                }

                @SuppressWarnings("unused")
                @android.webkit.JavascriptInterface
                public void playAudio(String url, String title, String artist) {
                    playAudio(url, title, artist, "");
                }

                @SuppressWarnings("unused")
                @android.webkit.JavascriptInterface
                public void pauseAudio() {
                    startServiceSafe(new Intent(MainActivity.this, MusicService.class).setAction("PAUSE"));
                }

                @SuppressWarnings("unused")
                @android.webkit.JavascriptInterface
                public void resumeAudio() {
                    startServiceSafe(new Intent(MainActivity.this, MusicService.class).setAction("RESUME"));
                }

                @SuppressWarnings("unused")
                @android.webkit.JavascriptInterface
                public void seekAudio(int ms) {
                    Intent intent = new Intent(MainActivity.this, MusicService.class).setAction("SEEK");
                    intent.putExtra("position", ms);
                    startServiceSafe(intent);
                }

                @SuppressWarnings("unused")
                @android.webkit.JavascriptInterface
                public void setAudioEffect(String type) {
                    Intent intent = new Intent(MainActivity.this, MusicService.class);
                    intent.setAction("SET_EFFECT");
                    intent.putExtra("effect_type", type);
                    startServiceSafe(intent);
                }
            }, "AndroidNative");
        }

        // 处理 Android 13+ (API 33+) 的通知权限
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && ContextCompat.checkSelfPermission(this, android.Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{android.Manifest.permission.POST_NOTIFICATIONS}, 101);
        }

        requestBatteryOptimizationExemption();

        startServiceSafe(new Intent(this, MusicService.class));

        receiver = new ServiceEventReceiver();
        IntentFilter filter = new IntentFilter();
        filter.addAction("com.YWJ.Aura.PROGRESS");
        filter.addAction("com.YWJ.Aura.SYNC_PLAY_STATE");
        filter.addAction("com.YWJ.Aura.ENDED");
        filter.addAction("com.YWJ.Aura.ERROR");
        filter.addAction("com.YWJ.Aura.NEXT");
        filter.addAction("com.YWJ.Aura.PREV");
        ContextCompat.registerReceiver(this, receiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED);
    }

    private void requestBatteryOptimizationExemption() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
            return;
        }

        PowerManager powerManager = (PowerManager) getSystemService(Context.POWER_SERVICE);
        if (powerManager == null || powerManager.isIgnoringBatteryOptimizations(getPackageName())) {
            return;
        }

        try {
            Intent intent = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
            intent.setData(Uri.parse("package:" + getPackageName()));
            startActivity(intent);
        } catch (Exception error) {
            Intent intent = new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
            startActivity(intent);
        }
    }

    private void startServiceSafe(Intent intent) {
        // 这里的 O (API 26) 检查还是建议保留，虽然你目前的设备 API 肯定大于 26，
        // 但如果有些老旧设备卡在 API 24/25，直接调 startForegroundService 会崩溃。
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(intent);
        } else {
            startService(intent);
        }
    }

    @Override
    public void onDestroy() {
        super.onDestroy();

        // 关键修复：
        // Activity / WebView 被系统销毁时，不能顺手 stopService。
        // 音乐播放服务必须独立于界面存在，否则锁屏、后台、旋转、系统回收时会导致播放链路重建，
        // 严重时会触发特殊音效破音、卡顿或状态丢失。
        if (receiver != null) {
            try {
                unregisterReceiver(receiver);
            } catch (Exception ignored) {
            }
            receiver = null;
        }
    }

    private class ServiceEventReceiver extends BroadcastReceiver {
        @Override
        public void onReceive(Context context, Intent intent) {
            WebView webView = bridge.getWebView();
            if (webView == null) return;
            String action = intent.getAction();

            webView.post(() -> {
                if ("com.YWJ.Aura.PROGRESS".equals(action)) {
                    int current = intent.getIntExtra("current", 0);
                    int duration = intent.getIntExtra("duration", 0);
                    webView.evaluateJavascript("window.AuraJS && window.AuraJS.onProgress(" + current + "," + duration + ");", null);
                } else if ("com.YWJ.Aura.SYNC_PLAY_STATE".equals(action)) {
                    boolean isPlaying = intent.getBooleanExtra("isPlaying", false);
                    webView.evaluateJavascript("window.AuraJS && window.AuraJS.onStateChanged(" + isPlaying + ");", null);
                } else if ("com.YWJ.Aura.ENDED".equals(action)) {
                    webView.evaluateJavascript("window.AuraJS && window.AuraJS.onEnded();", null);
                } else if ("com.YWJ.Aura.ERROR".equals(action)) {
                    webView.evaluateJavascript("window.AuraJS && window.AuraJS.onError();", null);
                } else if ("com.YWJ.Aura.NEXT".equals(action)) {
                    webView.evaluateJavascript("window.AuraJS && window.AuraJS.nativeNext();", null);
                } else if ("com.YWJ.Aura.PREV".equals(action)) {
                    webView.evaluateJavascript("window.AuraJS && window.AuraJS.nativePrev();", null);
                }
            });
        }
    }
}
