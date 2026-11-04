package de.lacoticomohd.strabfahrt;

import android.Manifest;
import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;

import org.json.JSONObject;

import java.net.URLEncoder;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;

/**
 * Abfahrts- und Ankunfts-Erinnerungen. Kurz vor dem Termin wird die Live-Verspätung abgefragt:
 * Ist die Bahn später dran, wird die Erinnerung verschoben, sonst kommt die Benachrichtigung.
 */
public class AlarmReceiver extends BroadcastReceiver {
    static final String CHANNEL = "reminders";
    private static final String PREFS_KEY = "alarms";

    static void set(Context c, String json) throws Exception {
        JSONObject a = new JSONObject(json);
        SharedPreferences p = StrabStore.prefs(c);
        JSONObject all = new JSONObject(p.getString(PREFS_KEY, "{}"));
        all.put(a.getString("key"), a);
        p.edit().putString(PREFS_KEY, all.toString()).apply();
        schedule(c, a, a.getLong("planned") - a.optInt("lead", 5) * 60L);
    }

    static void cancel(Context c, String key) throws Exception {
        SharedPreferences p = StrabStore.prefs(c);
        JSONObject all = new JSONObject(p.getString(PREFS_KEY, "{}"));
        all.remove(key);
        p.edit().putString(PREFS_KEY, all.toString()).apply();
        AlarmManager am = c.getSystemService(AlarmManager.class);
        am.cancel(pending(c, key));
    }

    private static PendingIntent pending(Context c, String key) {
        Intent i = new Intent(c, AlarmReceiver.class).setAction("de.lacoticomohd.strabfahrt.ALARM").putExtra("key", key);
        return PendingIntent.getBroadcast(c, key.hashCode(), i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /** Weckzeit in Unix-Sekunden; Android darf um wenige Minuten verschieben, deshalb 2 Min. früher prüfen. */
    private static void schedule(Context c, JSONObject a, long fireSec) throws Exception {
        long at = Math.max(System.currentTimeMillis() + 5000, (fireSec - 120) * 1000);
        AlarmManager am = c.getSystemService(AlarmManager.class);
        am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pending(c, a.getString("key")));
    }

    /** Nach einem Neustart sind Weckzeiten weg: alle offenen Erinnerungen neu stellen. */
    static void rescheduleAll(Context c) {
        try {
            JSONObject all = new JSONObject(StrabStore.prefs(c).getString(PREFS_KEY, "{}"));
            java.util.Iterator<String> it = all.keys();
            while (it.hasNext()) {
                JSONObject a = all.getJSONObject(it.next());
                schedule(c, a, a.getLong("planned") - a.optInt("lead", 5) * 60L);
            }
        } catch (Exception ignored) { /* nichts zu tun */ }
    }

    @Override
    public void onReceive(Context c, Intent intent) {
        if (Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())) { rescheduleAll(c); StrabStore.schedule(c); return; }
        String key = intent.getStringExtra("key");
        if (key == null) return;
        PendingResult result = goAsync();
        new Thread(() -> {
            try { handle(c, key); } catch (Exception ignored) { /* nächster Versuch nicht möglich, Erinnerung fällt weg */ }
            finally { result.finish(); }
        }).start();
    }

    private static void handle(Context c, String key) throws Exception {
        SharedPreferences p = StrabStore.prefs(c);
        JSONObject all = new JSONObject(p.getString(PREFS_KEY, "{}"));
        JSONObject a = all.optJSONObject(key);
        if (a == null) return;
        long planned = a.getLong("planned");
        int lead = a.optInt("lead", 5);
        long now = System.currentTimeMillis() / 1000;
        long delay = 0;
        boolean canceled = false;
        boolean live = false;
        try {
            String base = a.optString("base", "");
            if (!base.startsWith("https://")) base = StrabStore.base(c);
            if (base.endsWith("/")) base = base.substring(0, base.length() - 1);
            JSONObject t = new JSONObject(StrabWorker.get(base + "/api/trip?id=" + URLEncoder.encode(a.getString("trip"), "UTF-8") + "&stop=" + URLEncoder.encode(a.optString("stopId", ""), "UTF-8")));
            canceled = t.optBoolean("canceled");
            if (!t.isNull("delay")) { delay = t.optLong("delay"); live = true; }
        } catch (Exception offline) {
            // ohne Netz: nach Fahrplan erinnern
        }
        long real = planned + delay;
        // Bahn ist später dran als gedacht: Erinnerung verschieben (höchstens bis 3 Std. nach Plan)
        if (!canceled && real - lead * 60L > now + 180 && real < planned + 3 * 3600) {
            schedule(c, a, real - lead * 60L);
            return;
        }
        all.remove(key);
        p.edit().putString(PREFS_KEY, all.toString()).apply();
        notify(c, a, real, delay, live, canceled);
    }

    private static void notify(Context c, JSONObject a, long real, long delay, boolean live, boolean canceled) {
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(c, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return;
        ensureChannel(c);
        SimpleDateFormat f = new SimpleDateFormat("HH:mm", Locale.GERMANY);
        f.setTimeZone(TimeZone.getTimeZone("Europe/Berlin"));
        boolean arr = "arr".equals(a.optString("kind"));
        String head = a.optString("line") + " " + a.optString("dest");
        String text;
        if (canceled) {
            text = "Fällt aus! " + (arr ? "Ankunft " : "Abfahrt ") + a.optString("stopName");
        } else {
            long mins = Math.max(0, Math.round((real - System.currentTimeMillis() / 1000.0) / 60));
            String d = "";
            if (live) {
                long ad = Math.abs(delay);
                d = Math.abs(delay) < 30 ? " · pünktlich" : String.format(Locale.GERMANY, " · %s%d:%02d", delay > 0 ? "+" : "−", ad / 60, ad % 60);
            }
            text = (arr ? "Ankunft " : "Abfahrt ") + a.optString("stopName") + " um " + f.format(new Date(real * 1000)) + " (in " + mins + " Min.)" + d;
        }
        Intent open = new Intent(c, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        PendingIntent pi = PendingIntent.getActivity(c, 7, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        NotificationCompat.Builder b = new NotificationCompat.Builder(c, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
            .setContentTitle(head)
            .setContentText(text)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(text))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_REMINDER)
            .setContentIntent(pi)
            .setAutoCancel(true);
        NotificationManagerCompat.from(c).notify(a.optString("key").hashCode(), b.build());
    }

    static void ensureChannel(Context c) {
        if (Build.VERSION.SDK_INT < 26) return;
        android.app.NotificationChannel ch = new android.app.NotificationChannel(CHANNEL, "Erinnerungen", android.app.NotificationManager.IMPORTANCE_HIGH);
        ch.setDescription("Abfahrts- und Ankunfts-Erinnerungen");
        c.getSystemService(android.app.NotificationManager.class).createNotificationChannel(ch);
    }
}
