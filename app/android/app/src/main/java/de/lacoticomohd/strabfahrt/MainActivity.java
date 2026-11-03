package de.lacoticomohd.strabfahrt;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.BridgeActivity;

/**
 * Randloses Layout: Die Karte reicht unter Statusleiste und Navigationsleiste.
 * Die Höhen der Leisten gehen als CSS-Variablen --sat/--sab/--sal/--sar an die Seite,
 * damit Suchfeld und untere Leiste nicht verdeckt werden.
 */
public class MainActivity extends BridgeActivity {
    private volatile String insetsJson = "{\"t\":0,\"b\":0,\"l\":0,\"r\":0}";

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        getWindow().setStatusBarColor(Color.TRANSPARENT);
        getWindow().setNavigationBarColor(Color.TRANSPARENT);

        WebView web = getBridge().getWebView();
        web.addJavascriptInterface(new Bridge(), "StrabInsets");
        web.addJavascriptInterface(new NativeBridge(), "StrabNative");
        StrabStore.schedule(this);
        openAlertsFrom(getIntent());
        checkForUpdate(web);

        ViewCompat.setOnApplyWindowInsetsListener(web, (v, insets) -> {
            Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            float d = getResources().getDisplayMetrics().density;
            insetsJson = "{\"t\":" + Math.round(bars.top / d) + ",\"b\":" + Math.round(bars.bottom / d)
                + ",\"l\":" + Math.round(bars.left / d) + ",\"r\":" + Math.round(bars.right / d) + "}";
            v.post(() -> web.evaluateJavascript("window.strabApplyInsets && window.strabApplyInsets(" + insetsJson + ")", null));
            return insets;
        });
        ViewCompat.requestApplyInsets(web);
    }

    private volatile String pendingUpdate = "";

    // Neue APK unter GitHub-Releases? version.json vergleichen, Hinweis in der App zeigen
    private void checkForUpdate(WebView web) {
        new Thread(() -> {
            try {
                int mine = (int) androidx.core.content.pm.PackageInfoCompat.getLongVersionCode(getPackageManager().getPackageInfo(getPackageName(), 0));
                org.json.JSONObject v = new org.json.JSONObject(StrabWorker.get(UPDATE_URL));
                if (v.optInt("versionCode", 0) <= mine) return;
                pendingUpdate = v.toString();
                web.postDelayed(() -> web.evaluateJavascript("window.strabShowUpdate && window.strabShowUpdate(" + pendingUpdate + ")", null), 4000);
            } catch (Exception ignored) {
                // offline oder noch keine Version veröffentlicht
            }
        }).start();
    }

    private static final String UPDATE_URL = "https://github.com/LacoticomoHD/Strabfahrt/releases/download/app/version.json";

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        openAlertsFrom(intent);
    }

    // Tipp auf eine Störungs-Benachrichtigung: Meldungen in der App öffnen
    private void openAlertsFrom(Intent intent) {
        if (intent == null) return;
        String station = intent.getStringExtra("station");
        if (station != null) {
            intent.removeExtra("station");
            WebView w = getBridge().getWebView();
            String q = org.json.JSONObject.quote(station);
            String js = "window.strabOpenStationId ? window.strabOpenStationId(" + q + ") : (window.__strabOpenId = " + q + ")";
            for (int ms : new int[] { 800, 2500, 5000 }) w.postDelayed(() -> w.evaluateJavascript(js, null), ms);
        }
        if (!intent.getBooleanExtra("openAlerts", false)) return;
        intent.removeExtra("openAlerts");
        WebView web = getBridge().getWebView();
        web.postDelayed(() -> web.evaluateJavascript("window.strabOpenAlerts && window.strabOpenAlerts()", null), 1500);
    }

    // Schnellstart-Kacheln: lange auf das App-Symbol drücken, Favoriten direkt öffnen (höchstens 4)
    private void updateShortcuts(String favoritesJson) {
        try {
            org.json.JSONArray favs = new org.json.JSONArray(favoritesJson);
            java.util.List<androidx.core.content.pm.ShortcutInfoCompat> list = new java.util.ArrayList<>();
            int max = Math.min(4, androidx.core.content.pm.ShortcutManagerCompat.getMaxShortcutCountPerActivity(this));
            for (int i = 0; i < favs.length() && list.size() < max; i++) {
                org.json.JSONObject f = favs.getJSONObject(i);
                String name = f.optString("name", "Haltestelle");
                Intent open = new Intent(this, MainActivity.class).setAction(Intent.ACTION_VIEW).putExtra("station", f.getString("id"));
                list.add(new androidx.core.content.pm.ShortcutInfoCompat.Builder(this, "fav-" + i)
                    .setShortLabel(name.length() > 24 ? name.substring(0, 24) : name)
                    .setLongLabel(name)
                    .setIcon(androidx.core.graphics.drawable.IconCompat.createWithResource(this, R.mipmap.ic_launcher))
                    .setIntent(open)
                    .build());
            }
            androidx.core.content.pm.ShortcutManagerCompat.setDynamicShortcuts(this, list);
        } catch (Exception ignored) { /* Kacheln sind optional */ }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != 4711) return;
        boolean granted = grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED;
        StrabStore.setNotify(this, granted);
        if (granted) StrabStore.refreshNow(this);
        WebView web = getBridge().getWebView();
        web.post(() -> web.evaluateJavascript("window.strabNotifyChanged && window.strabNotifyChanged(" + granted + ")", null));
    }

    /** Favoriten fürs Widget, Benachrichtigungen bei Störungen. */
    private class NativeBridge {
        @JavascriptInterface
        public void setFavorites(String favoritesJson, String linesJson, String base) {
            StrabStore.save(MainActivity.this, favoritesJson, linesJson, base);
            StrabStore.refreshNow(MainActivity.this);
            updateShortcuts(favoritesJson);
        }

        @JavascriptInterface
        public void setAlarm(String json) {
            try { AlarmReceiver.set(MainActivity.this, json); } catch (Exception e) { return; }
            if (!hasPermission()) runOnUiThread(() -> ActivityCompat.requestPermissions(MainActivity.this, new String[] { Manifest.permission.POST_NOTIFICATIONS }, 4712));
        }

        @JavascriptInterface
        public void cancelAlarm(String key) {
            try { AlarmReceiver.cancel(MainActivity.this, key); } catch (Exception ignored) { /* schon weg */ }
        }

        @JavascriptInterface
        public String pendingUpdate() {
            return pendingUpdate;
        }

        @JavascriptInterface
        public boolean notifyEnabled() {
            return StrabStore.notifyEnabled(MainActivity.this) && hasPermission();
        }

        @JavascriptInterface
        public void setNotify(boolean on) {
            if (!on) { StrabStore.setNotify(MainActivity.this, false); return; }
            if (hasPermission()) {
                StrabStore.setNotify(MainActivity.this, true);
                StrabStore.refreshNow(MainActivity.this);
                return;
            }
            runOnUiThread(() -> ActivityCompat.requestPermissions(MainActivity.this, new String[] { Manifest.permission.POST_NOTIFICATIONS }, 4711));
        }

        private boolean hasPermission() {
            return Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(MainActivity.this, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
        }
    }

    private class Bridge {
        @JavascriptInterface
        public String get() {
            return insetsJson;
        }

        /** Helle Seite: dunkle Symbole in den Systemleisten, dunkle Seite: helle Symbole. */
        @JavascriptInterface
        public void setLight(boolean light) {
            runOnUiThread(() -> {
                WindowInsetsControllerCompat c = WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
                c.setAppearanceLightStatusBars(light);
                c.setAppearanceLightNavigationBars(light);
            });
        }
    }
}
