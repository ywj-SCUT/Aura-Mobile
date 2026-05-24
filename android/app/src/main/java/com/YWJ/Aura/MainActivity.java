package com.YWJ.Aura;

import com.getcapacitor.BridgeActivity;
import android.os.Bundle;

public class MainActivity extends BridgeActivity {
    
    // 加入下面这段代码，防止应用退到后台时音乐暂停
    @Override
    public void onPause() {
        super.onPause();
        // 强制让 WebView 在后台保持活跃，继续播放音乐
        if (bridge != null && bridge.getWebView() != null) {
            bridge.getWebView().resumeTimers();
            bridge.getWebView().onResume();
        }
    }
}