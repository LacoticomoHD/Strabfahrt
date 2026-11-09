package de.lacoticomohd.strabfahrt;

import android.content.Context;
import android.content.SharedPreferences;

import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;

import java.util.concurrent.TimeUnit;

/** Gemeinsame Einstellungen von App, Widget und Hintergrundabfrage. */
final class StrabStore {
    static final String DEFAULT_BASE = "https://strabfahrt.vercel.app";
    private static final String PREFS = "strabfahrt";

    private StrabStore() {}

    static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static String base(Context c) {
        String b = prefs(c).getString("base", DEFAULT_BASE);
        return b.endsWith("/") ? b.substring(0, b.length() - 1) : b;
    }

    /** Favoriten [{id,name}], Linien der Favoriten, Benachrichtigungen ja/nein. */
    static void save(Context c, String favoritesJson, String linesJson, String base) {
        SharedPreferences.Editor e = prefs(c).edit();
        if (favoritesJson != null) e.putString("favorites", favoritesJson);
        if (linesJson != null) e.putString("lines", linesJson);
        if (base != null && base.startsWith("https://")) e.putString("base", base);
        e.apply();
    }

    static boolean notifyEnabled(Context c) {
        return prefs(c).getBoolean("notify", false);
    }

    static void setNotify(Context c, boolean on) {
        prefs(c).edit().putBoolean("notify", on).apply();
    }

    /** Alle 15 Minuten (Mindestabstand bei Android) Widget und Meldungen aktualisieren. */
    static void schedule(Context c) {
        Constraints net = new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build();
        PeriodicWorkRequest periodic = new PeriodicWorkRequest.Builder(StrabWorker.class, 15, TimeUnit.MINUTES)
            .setConstraints(net).build();
        WorkManager.getInstance(c).enqueueUniquePeriodicWork("strab-periodic", ExistingPeriodicWorkPolicy.KEEP, periodic);
    }

    private static final java.util.concurrent.ExecutorService EXEC = java.util.concurrent.Executors.newSingleThreadExecutor();

    /** Sofort einmal aktualisieren (App-Start, neue Favoriten). */
    static void refreshNow(Context c) {
        refreshAsync(c.getApplicationContext(), null, false);
    }

    /**
     * Widget direkt neu laden, ohne Umweg über die Hintergrund-Planung von Android (die verzögert oft um Minuten).
     * pr: laufende Rundsendung, wird am Ende freigegeben. loading: "lädt …" anzeigen.
     */
    static void refreshAsync(Context app, android.content.BroadcastReceiver.PendingResult pr, boolean loading) {
        EXEC.execute(() -> {
            try {
                if (loading) StrabWorker.showLoading(app);
                else StrabWorker.renderCached(app, null);
                StrabWorker.updateWidgets(app, 4000, 5500);
            } catch (Exception e) {
                // Zweiter Versuch über die Hintergrund-Planung, sobald wieder Netz da ist
                try {
                    Constraints net = new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build();
                    WorkManager.getInstance(app).enqueueUniqueWork("strab-now", ExistingWorkPolicy.KEEP,
                        new OneTimeWorkRequest.Builder(StrabWorker.class).setConstraints(net).build());
                } catch (Exception ignored) { }
            } finally {
                if (pr != null) pr.finish();
            }
        });
    }

    private static final long TICK_MS = 2 * 60 * 1000;

    /**
     * Nächste Widget-Aktualisierung vormerken. Der Wecker weckt das Handy nicht auf (schont den Akku):
     * Bei gesperrtem, schlafendem Gerät wartet er und läuft beim Aufwecken sofort, danach alle zwei Minuten.
     */
    static void scheduleTick(Context c) {
        android.app.AlarmManager am = (android.app.AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;
        int[] ids = android.appwidget.AppWidgetManager.getInstance(c).getAppWidgetIds(new android.content.ComponentName(c, DepartureWidget.class));
        android.app.PendingIntent pi = tickIntent(c);
        if (ids.length == 0) { am.cancel(pi); return; }
        long at = android.os.SystemClock.elapsedRealtime() + TICK_MS;
        if (android.os.Build.VERSION.SDK_INT >= 23) am.setAndAllowWhileIdle(android.app.AlarmManager.ELAPSED_REALTIME, at, pi);
        else am.set(android.app.AlarmManager.ELAPSED_REALTIME, at, pi);
    }

    static android.app.PendingIntent tickIntent(Context c) {
        android.content.Intent i = new android.content.Intent(c, DepartureWidget.class).setAction(DepartureWidget.ACTION_TICK);
        return android.app.PendingIntent.getBroadcast(c, 2, i, android.app.PendingIntent.FLAG_UPDATE_CURRENT | android.app.PendingIntent.FLAG_IMMUTABLE);
    }
}
