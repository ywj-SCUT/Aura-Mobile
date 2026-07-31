package com.YWJ.Aura;

import android.app.Application;
import android.content.Context;
import android.net.Uri;
import android.util.Log;

import com.danikula.videocache.HttpProxyCacheServer;
import com.danikula.videocache.file.Md5FileNameGenerator;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;

public class AuraApplication extends Application {

    private HttpProxyCacheServer proxy;
    private static final String TAG = "AuraCacheRadar";

    public static HttpProxyCacheServer getProxy(Context context) {
        AuraApplication app = (AuraApplication) context.getApplicationContext();
        return app.proxy == null ? (app.proxy = app.newProxy()) : app.proxy;
    }

    public static String resolveCacheUrl(Context context, String url) {
        return resolveCacheUrl(context, url, null);
    }

    public static String resolveCacheUrl(Context context, String url, String legacyCacheUrl) {
        if (url == null || url.trim().isEmpty()) {
            return url;
        }

        HttpProxyCacheServer proxy = getProxy(context);
        if (proxy.isCached(url)) {
            return url;
        }

        String legacyUrl = legacyCacheUrl;
        if (legacyUrl == null || legacyUrl.trim().isEmpty()) {
            legacyUrl = Uri.parse(url).getQueryParameter("auraLegacyUrl");
        }
        if (legacyUrl != null && !legacyUrl.trim().isEmpty() && proxy.isCached(legacyUrl)) {
            Log.i(TAG, "Using compatible legacy cache entry");
            return legacyUrl;
        }

        return url;
    }

    private HttpProxyCacheServer newProxy() {
        File rootFilesDir = getExternalFilesDir(null);
        if (rootFilesDir == null) {
            rootFilesDir = getFilesDir();
        }

        File cacheDir = new File(rootFilesDir, "audio-library");

        if (!cacheDir.exists()) {
            boolean isCreated = cacheDir.mkdirs();
            if (!isCreated) {
                Log.e(TAG, "❌ [Aura 雷达] 严重错误：无法创建缓存目录！请检查存储空间或底层权限。");
            } else {
                Log.i(TAG, "✅ [Aura 雷达] 成功创建全新的缓存目录。");
            }
        }

        migrateLegacyCache(cacheDir);

        Log.i(TAG, "===============================================");
        Log.i(TAG, "🔥 音频底层缓存雷达启动！");
        Log.i(TAG, "🔥 真实物理路径: " + cacheDir.getAbsolutePath());
        Log.i(TAG, "===============================================");

        return new HttpProxyCacheServer.Builder(this)
                .maxCacheSize(Long.MAX_VALUE)
                .cacheDirectory(cacheDir)
                .fileNameGenerator(new MusicFileNameGenerator())
                .build();
    }

    private void migrateLegacyCache(File destinationDir) {
        File externalCacheDir = getExternalCacheDir();
        if (externalCacheDir == null) {
            return;
        }

        File legacyDir = new File(externalCacheDir, "video-cache");
        File[] completedFiles = legacyDir.listFiles((dir, name) -> name.endsWith(".aura"));
        if (completedFiles == null) {
            return;
        }

        for (File source : completedFiles) {
            File destination = new File(destinationDir, source.getName());
            if (destination.exists() && destination.length() == source.length()) {
                continue;
            }

            try {
                copyFile(source, destination);
                Log.i(TAG, "Migrated completed legacy cache: " + source.getName());
            } catch (IOException error) {
                Log.e(TAG, "Failed to migrate legacy cache: " + source.getName(), error);
            }
        }
    }

    private static void copyFile(File source, File destination) throws IOException {
        File temporary = new File(destination.getParentFile(), destination.getName() + ".migrating");
        try (FileInputStream input = new FileInputStream(source);
             FileOutputStream output = new FileOutputStream(temporary)) {
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = input.read(buffer)) != -1) {
                output.write(buffer, 0, read);
            }
            output.getFD().sync();
        }

        if (temporary.length() != source.length()) {
            temporary.delete();
            throw new IOException("Cache copy validation failed");
        }
        if ((destination.exists() && !destination.delete()) || !temporary.renameTo(destination)) {
            temporary.delete();
            throw new IOException("Cache copy validation failed");
        }
    }

    private static class MusicFileNameGenerator extends Md5FileNameGenerator {
        @Override
        public String generate(String url) {
            String cacheUrl = url == null ? "" : url;
            String stableCacheKey = Uri.parse(cacheUrl).getQueryParameter("auraCacheKey");
            if (stableCacheKey != null && !stableCacheKey.trim().isEmpty()) {
                cacheUrl = "aura-cache-v2:" + stableCacheKey;
            } else if (cacheUrl.contains("&t=")) {
                cacheUrl = cacheUrl.substring(0, cacheUrl.indexOf("&t="));
            }
            String finalName = super.generate(cacheUrl) + ".aura";
            Log.i(TAG, "💾 正在拦截并缓存流媒体，生成文件名: " + finalName);
            return finalName;
        }
    }
}
