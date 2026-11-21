package com.wornhack.hud;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.os.Bundle;
import android.speech.tts.TextToSpeech;
import android.util.Log;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Locale;

/**
 * Worn HUD for the MicroLumin M6 (Android 9, 640x480).
 *
 * Shows the laptop server's /hud page full screen and forwards every temple-touchpad / ring key
 * to the page (window.onGlassesKey) and to the server (POST /api/key).
 *
 * Server URL: defaults to http://localhost:8787/hud, which reaches the laptop over USB after
 *   adb reverse tcp:8787 tcp:8787
 * Override (saved for next launch):
 *   adb shell am start -n com.wornhack.hud/.MainActivity --es url http://LAPTOP_IP:8787/hud
 */
public class MainActivity extends Activity {
    private static final String TAG = "WornHUD";
    private static final String DEFAULT_URL = "http://localhost:8787/hud";

    private WebView web;
    private String hudUrl;
    private TextToSpeech tts;
    private boolean ttsReady;
    private long lastBackAt;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
                | WindowManager.LayoutParams.FLAG_FULLSCREEN);
        // Full brightness while NAVIQ is up: the system setting drifts down (we found it at 25/255, invisible indoors).
        WindowManager.LayoutParams lp = getWindow().getAttributes();
        lp.screenBrightness = 1f;
        getWindow().setAttributes(lp);

        readUrl(getIntent());

        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED
                || checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO}, 1);
        }

        WebView.setWebContentsDebuggingEnabled(true); // chrome://inspect from the laptop
        web = new WebView(this);
        web.setBackgroundColor(Color.BLACK);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);

        web.setWebViewClient(new HudClient());
        web.setWebChromeClient(new GrantingChromeClient());
        web.setFocusable(false); // keys come to the activity, not the page
        web.addJavascriptInterface(new GlassesBridge(), "Glasses"); // window.Glasses.speak(text)
        tts = new TextToSpeech(this, new TtsInit());

        setContentView(web);
        load();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (readUrl(intent)) load();
    }

    /** Returns true if the intent carried a new URL. */
    private boolean readUrl(Intent intent) {
        SharedPreferences prefs = getSharedPreferences("hud", MODE_PRIVATE);
        String fromIntent = intent == null ? null : intent.getStringExtra("url");
        if (fromIntent != null && fromIntent.length() > 0) {
            prefs.edit().putString("url", fromIntent).apply();
        }
        hudUrl = prefs.getString("url", DEFAULT_URL);
        return fromIntent != null;
    }

    private void load() {
        String url = hudUrl + (hudUrl.contains("?") ? "&" : "?") + "glasses=1";
        Log.i(TAG, "loading " + url);
        web.loadUrl(url);
    }

    private void showError(String description) {
        String html = "<body style='background:#000;color:#3cff6e;font:30px monospace;padding:40px'>"
                + "Can't reach server<br><br><span style='font-size:20px'>" + hudUrl + "<br>" + description
                + "<br><br>Retrying every 3 s…</span></body>";
        web.loadDataWithBaseURL(null, html, "text/html", "utf-8", null);
        web.postDelayed(new Reload(), 3000);
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.getRootView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                | View.SYSTEM_UI_FLAG_FULLSCREEN
                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        int code = event.getKeyCode();
        String name = KeyEvent.keyCodeToString(code);
        if (event.getAction() == KeyEvent.ACTION_DOWN && event.getRepeatCount() == 0) {
            Log.i(TAG, "key " + name + " (" + code + ")");
            web.evaluateJavascript("window.onGlassesKey && window.onGlassesKey(" + code + ",'" + name + "')", null);
            postKey(code, name);
        }
        // BACK twice within 1.5 s leaves the app; a single BACK goes to the page. HOME always works.
        if (code == KeyEvent.KEYCODE_BACK && event.getAction() == KeyEvent.ACTION_DOWN && event.getRepeatCount() == 0) {
            long now = System.currentTimeMillis();
            if (now - lastBackAt < 1500) { finish(); return true; }
            lastBackAt = now;
        }
        if (code == KeyEvent.KEYCODE_HOME) return super.dispatchKeyEvent(event);
        return true;
    }

    private void postKey(int code, String name) {
        new Thread(new KeyPoster(hudUrl, code, name)).start();
    }

    // Named classes rather than anonymous ones: d8 34 crashes on anonymous classes compiled by JDK 25.

    private class HudClient extends WebViewClient {
        @Override
        @SuppressWarnings("deprecation")
        public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) {
            showError(description);
        }
    }

    private static class GrantingChromeClient extends WebChromeClient {
        @Override
        public void onPermissionRequest(PermissionRequest request) {
            // Let the HUD page use the glasses camera / mic via getUserMedia (needs localhost or https).
            request.grant(request.getResources());
        }
    }

    private class Reload implements Runnable {
        public void run() { load(); }
    }

    private static class KeyPoster implements Runnable {
        private final String hudUrl;
        private final int code;
        private final String name;

        KeyPoster(String hudUrl, int code, String name) {
            this.hudUrl = hudUrl;
            this.code = code;
            this.name = name;
        }

        public void run() {
            HttpURLConnection c = null;
            try {
                URL hud = new URL(hudUrl);
                URL api = new URL(hud.getProtocol(), hud.getHost(), hud.getPort(), "/api/key");
                c = (HttpURLConnection) api.openConnection();
                c.setConnectTimeout(2000);
                c.setReadTimeout(2000);
                c.setRequestMethod("POST");
                c.setRequestProperty("content-type", "application/json");
                c.setDoOutput(true);
                OutputStream os = c.getOutputStream();
                os.write(("{\"code\":" + code + ",\"name\":\"" + name + "\"}").getBytes("UTF-8"));
                os.close();
                c.getResponseCode();
            } catch (Exception e) {
                Log.w(TAG, "postKey failed: " + e);
            } finally {
                if (c != null) c.disconnect();
            }
        }
    }

    private class TtsInit implements TextToSpeech.OnInitListener {
        public void onInit(int status) {
            ttsReady = status == TextToSpeech.SUCCESS;
            if (ttsReady) tts.setLanguage(Locale.US);
            Log.i(TAG, "tts ready=" + ttsReady);
        }
    }

    /** Exposed to the HUD page as window.Glasses. */
    public class GlassesBridge {
        @JavascriptInterface
        public void speak(String text) {
            if (tts != null && ttsReady && text != null) tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, "naviq");
        }

        @JavascriptInterface
        public boolean canSpeak() {
            return ttsReady;
        }
    }

    @Override
    protected void onDestroy() {
        if (tts != null) tts.shutdown();
        if (web != null) web.destroy();
        super.onDestroy();
    }
}
