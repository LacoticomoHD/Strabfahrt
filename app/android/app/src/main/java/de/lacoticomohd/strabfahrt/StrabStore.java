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

    /** Sofort einmal aktualisieren (Widget-Knopf, App-Start, neue Favoriten). */
    static void refreshNow(Context c) {
        Constraints net = new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build();
        OneTimeWorkRequest once = new OneTimeWorkRequest.Builder(StrabWorker.class).setConstraints(net).build();
        WorkManager.getInstance(c).enqueueUniqueWork("strab-now", ExistingWorkPolicy.REPLACE, once);
    }
}
