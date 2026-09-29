package com.alghulventures.tvcinema;

import android.app.Activity;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.SslErrorHandler;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import org.json.JSONObject;

public final class MainActivity extends Activity {
    private FrameLayout root;
    private WebView webView;
    private ProgressBar progress;
    private TextView errorMessage;
    private View fullscreenView;
    private WebChromeClient.CustomViewCallback fullscreenCallback;
    private int previousSystemUiVisibility;

    private static final class RemoteKey {
        final String key;
        final String code;
        final int webKeyCode;
        RemoteKey(String key, String code, int webKeyCode) {
            this.key = key; this.code = code; this.webKeyCode = webKeyCode;
        }
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        getWindow().setFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON,
                WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        root = new FrameLayout(this);
        root.setBackgroundColor(Color.rgb(17, 17, 17));
        setContentView(root);

        String configuredUrl = BuildConfig.HOME_CINEMA_URL.trim();
        if (configuredUrl.isEmpty()) {
            showMessage("Set -PhomeCinemaUrl to your Home Cinema HTTPS address when building this app.");
            return;
        }

        final Uri baseUri;
        try {
            baseUri = Uri.parse(configuredUrl);
            if (!"https".equalsIgnoreCase(baseUri.getScheme()) || baseUri.getHost() == null
                    || baseUri.getUserInfo() != null) {
                throw new IllegalArgumentException("Use a valid HTTPS site address.");
            }
        } catch (RuntimeException invalidUrl) {
            showMessage("The Home Cinema address is invalid. Build the app with a valid HTTPS URL.");
            return;
        }

        webView = new WebView(this);
        webView.setBackgroundColor(Color.rgb(17, 17, 17));
        webView.setFocusable(true);
        webView.setFocusableInTouchMode(true);
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                String scheme = request.getUrl().getScheme();
                // Keep browsing in this shell and never hand arbitrary links to external apps.
                return !"https".equalsIgnoreCase(scheme);
            }

            @Override
            public void onReceivedSslError(WebView view, SslErrorHandler handler,
                                           android.net.http.SslError error) {
                handler.cancel();
                showError("Could not establish a secure connection to Home Cinema.");
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request,
                                        android.webkit.WebResourceError error) {
                if (request.isForMainFrame()) {
                    showError("Home Cinema could not be reached. Check the TV's network and try again.");
                }
            }

            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                if (progress != null) progress.setVisibility(View.VISIBLE);
                if (errorMessage != null) errorMessage.setVisibility(View.GONE);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                if (progress != null) progress.setVisibility(View.GONE);
            }
        });

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setSupportMultipleWindows(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSafeBrowsingEnabled(true);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true);

        root.addView(webView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        progress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progress.setIndeterminate(true);
        FrameLayout.LayoutParams progressLayout = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(3), android.view.Gravity.TOP);
        root.addView(progress, progressLayout);

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int value) {
                if (progress != null) {
                    progress.setIndeterminate(false);
                    progress.setProgress(value);
                    progress.setVisibility(value >= 100 ? View.GONE : View.VISIBLE);
                }
            }

            @Override
            public void onShowCustomView(View view, CustomViewCallback callback) {
                if (fullscreenView != null) {
                    callback.onCustomViewHidden();
                    return;
                }
                fullscreenView = view;
                fullscreenCallback = callback;
                previousSystemUiVisibility = getWindow().getDecorView().getSystemUiVisibility();
                webView.setVisibility(View.GONE);
                root.addView(view, new FrameLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
                getWindow().getDecorView().setSystemUiVisibility(
                        View.SYSTEM_UI_FLAG_FULLSCREEN
                                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                                | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                                | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                                | View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
                view.setFocusable(true);
                view.requestFocus();
            }

            @Override
            public void onHideCustomView() {
                if (fullscreenView == null) return;
                root.removeView(fullscreenView);
                fullscreenView = null;
                getWindow().getDecorView().setSystemUiVisibility(previousSystemUiVisibility);
                webView.setVisibility(View.VISIBLE);
                webView.requestFocus();
                if (fullscreenCallback != null) fullscreenCallback.onCustomViewHidden();
                fullscreenCallback = null;
            }
        });

        Uri launchUri = baseUri.buildUpon().appendQueryParameter("tv", "1").build();
        webView.loadUrl(launchUri.toString());
    }

    private void showMessage(String message) {
        TextView view = new TextView(this);
        view.setText(message);
        view.setTextColor(Color.WHITE);
        view.setTextSize(20);
        view.setGravity(android.view.Gravity.CENTER);
        view.setPadding(dp(48), dp(32), dp(48), dp(32));
        root.addView(view, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    }

    private void showError(String message) {
        if (errorMessage == null) {
            errorMessage = new TextView(this);
            errorMessage.setTextColor(Color.WHITE);
            errorMessage.setTextSize(20);
            errorMessage.setGravity(android.view.Gravity.CENTER);
            errorMessage.setFocusable(true);
            errorMessage.setFocusableInTouchMode(true);
            errorMessage.setPadding(dp(48), dp(32), dp(48), dp(32));
            errorMessage.setOnClickListener(ignored -> webView.reload());
            root.addView(errorMessage, new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        }
        errorMessage.setText(message + "\n\nPress OK to retry.");
        errorMessage.setVisibility(View.VISIBLE);
        errorMessage.requestFocus();
        if (progress != null) progress.setVisibility(View.GONE);
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private RemoteKey mapRemoteKey(KeyEvent event) {
        int code = event.getKeyCode();
        switch (code) {
            case KeyEvent.KEYCODE_DPAD_UP: return new RemoteKey("ArrowUp", "ArrowUp", 38);
            case KeyEvent.KEYCODE_DPAD_DOWN: return new RemoteKey("ArrowDown", "ArrowDown", 40);
            case KeyEvent.KEYCODE_DPAD_LEFT: return new RemoteKey("ArrowLeft", "ArrowLeft", 37);
            case KeyEvent.KEYCODE_DPAD_RIGHT: return new RemoteKey("ArrowRight", "ArrowRight", 39);
            case KeyEvent.KEYCODE_DPAD_CENTER:
            case KeyEvent.KEYCODE_ENTER:
            case KeyEvent.KEYCODE_NUMPAD_ENTER: return new RemoteKey("Enter", "Enter", 13);
            case KeyEvent.KEYCODE_MEDIA_PLAY: return new RemoteKey("MediaPlay", "MediaPlay", 415);
            case KeyEvent.KEYCODE_MEDIA_PAUSE: return new RemoteKey("MediaPause", "MediaPause", 19);
            case KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE: return new RemoteKey("MediaPlayPause", "MediaPlayPause", 10252);
            case KeyEvent.KEYCODE_MEDIA_REWIND: return new RemoteKey("MediaRewind", "MediaRewind", 412);
            case KeyEvent.KEYCODE_MEDIA_FAST_FORWARD: return new RemoteKey("MediaFastForward", "MediaFastForward", 417);
            case KeyEvent.KEYCODE_CHANNEL_UP: return new RemoteKey("ChannelUp", "ChannelUp", 166);
            case KeyEvent.KEYCODE_CHANNEL_DOWN: return new RemoteKey("ChannelDown", "ChannelDown", 167);
            case KeyEvent.KEYCODE_CAPTIONS: return new RemoteKey("CaptionToggle", "CaptionToggle", 175);
            case KeyEvent.KEYCODE_MEDIA_RECORD: return new RemoteKey("MediaRecord", "MediaRecord", 130);
            default:
                if (code >= KeyEvent.KEYCODE_0 && code <= KeyEvent.KEYCODE_9) {
                    int digit = code == KeyEvent.KEYCODE_0 ? 0 : code - KeyEvent.KEYCODE_1 + 1;
                    return new RemoteKey(String.valueOf(digit), "Digit" + digit, 48 + digit);
                }
                // Keep unfamiliar remote keys available to the page as named native events.
                String name = KeyEvent.keyCodeToString(code).replace("KEYCODE_", "");
                if ("UNKNOWN".equals(name) || "BACK".equals(name) || "VOLUME_UP".equals(name)
                        || "VOLUME_DOWN".equals(name) || "VOLUME_MUTE".equals(name)) return null;
                return new RemoteKey(name, name, code);
        }
    }

    private void dispatchRemoteKey(KeyEvent event, RemoteKey key) {
        if (webView == null) return;
        try {
            JSONObject detail = new JSONObject();
            detail.put("key", key.key);
            detail.put("code", key.code);
            detail.put("keyCode", key.webKeyCode);
            detail.put("scanCode", event.getScanCode());
            detail.put("androidKeyCode", event.getKeyCode());
            detail.put("source", event.getSource());
            detail.put("action", event.getAction() == KeyEvent.ACTION_DOWN ? "down" : "up");
            detail.put("repeat", event.getRepeatCount() > 0);
            String keyJson = JSONObject.quote(key.key);
            String codeJson = JSONObject.quote(key.code);
            String js = "(() => { const detail=" + detail.toString() + "; window.dispatchEvent(new CustomEvent('tv-remote-key',{detail})); "
                    + "const target=document.activeElement||document.body; const init={key:" + keyJson + ",code:" + codeJson
                    + ",keyCode:" + key.webKeyCode + ",which:" + key.webKeyCode + ",bubbles:true,cancelable:true,repeat:" + (event.getRepeatCount() > 0) + "}; "
                    + "target.dispatchEvent(new KeyboardEvent(" + JSONObject.quote(event.getAction() == KeyEvent.ACTION_DOWN ? "keydown" : "keyup") + ",init)); return true; })()";
            webView.evaluateJavascript(js, null);
        } catch (Exception ignored) { }
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        // Fullscreen requires a trusted browser gesture. evaluateJavascript-created
        // events cannot grant user activation, so deliver OK and Record natively.
        if (webView != null && (errorMessage == null || errorMessage.getVisibility() != View.VISIBLE)) {
            int code = event.getKeyCode();
            int browserCode = code == KeyEvent.KEYCODE_MEDIA_RECORD ? KeyEvent.KEYCODE_F
                    : (code == KeyEvent.KEYCODE_DPAD_CENTER || code == KeyEvent.KEYCODE_ENTER
                    || code == KeyEvent.KEYCODE_NUMPAD_ENTER) ? KeyEvent.KEYCODE_ENTER : 0;
            if (browserCode != 0) {
                webView.dispatchKeyEvent(new KeyEvent(event.getDownTime(), event.getEventTime(),
                        event.getAction(), browserCode, event.getRepeatCount(), event.getMetaState(),
                        event.getDeviceId(), event.getScanCode(), event.getFlags(), event.getSource()));
                return true;
            }
        }
        RemoteKey key = mapRemoteKey(event);
        if (key != null && webView != null && errorMessage == null) {
            dispatchRemoteKey(event, key);
            return true;
        }
        return super.dispatchKeyEvent(event);
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            if (fullscreenView != null && webView != null) {
                webView.evaluateJavascript("document.exitFullscreen(); true", null);
                return true;
            }
            if (errorMessage != null && errorMessage.getVisibility() == View.VISIBLE) {
                errorMessage.setVisibility(View.GONE);
                if (webView != null) webView.reload();
                return true;
            }
            if (webView != null) {
                webView.evaluateJavascript("(() => { window.dispatchEvent(new CustomEvent('tv-remote-key',{detail:{key:'Back',code:'Back',keyCode:4,androidKeyCode:4,scanCode:0,action:'down',repeat:false}})); const e = new KeyboardEvent('keydown', {key:'Escape',code:'Escape',keyCode:27,which:27,bubbles:true,cancelable:true}); (document.activeElement||document).dispatchEvent(e); return e.defaultPrevented; })()",
                        handled -> {
                            if (!"true".equals(handled)) {
                                if (webView.canGoBack()) webView.goBack();
                                else finish();
                            }
                        });
                return true;
            }
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.stopLoading();
            webView.setWebChromeClient(null);
            webView.setWebViewClient(null);
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
