package de.lacoticomohd.strabfahrt;

import android.graphics.Color;
import android.os.Bundle;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

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
