package de.lacoticomohd.strabfahrt;

import android.Manifest;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.os.Build;
import android.view.View;
import android.widget.RemoteViews;

import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Pattern;

/** Holt Abfahrten für das Widget und Störungsmeldungen für die Favoriten. */
public class StrabWorker extends Worker {
    static final String CHANNEL = "alerts";
    private static final int ROWS = 5;

    public StrabWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        Context c = getApplicationContext();
        boolean ok = true;
        try { updateWidgets(c); } catch (Exception e) { ok = false; }
        try { if (StrabStore.notifyEnabled(c)) checkAlerts(c); } catch (Exception e) { ok = false; }
        return ok ? Result.success() : Result.retry();
    }

    // ---------- Widget ----------

    private static final int FETCH = 10; // Reserve, damit abgefahrene Zeilen ohne neuen Abruf nachrücken können

    /** Abfahrten holen und anzeigen. Ohne Netz bleibt der letzte Stand stehen, abgefahrene Zeilen fallen weg. */
    static void updateWidgets(Context c) throws Exception { updateWidgets(c, 15000, 30000); }

    static void updateWidgets(Context c, int connectMs, int readMs) throws Exception {
        AppWidgetManager mgr = AppWidgetManager.getInstance(c);
        int[] ids = mgr.getAppWidgetIds(new ComponentName(c, DepartureWidget.class));
        if (ids.length == 0) return;
        SharedPreferences p = StrabStore.prefs(c);
        JSONArray favs = new JSONArray(p.getString("favorites", "[]"));
        if (favs.length() == 0) { renderCached(c, null); return; }
        JSONObject fav = favs.getJSONObject(0);
        String stopId = fav.getString("id");
        try {
            String body = get(StrabStore.base(c) + "/api/departures?limit=" + FETCH + "&stop=" + URLEncoder.encode(stopId, "UTF-8"), connectMs, readMs);
            new JSONObject(body); // nur gültige Antworten merken
            p.edit().putString("widgetData", body).putString("widgetStop", stopId).putLong("widgetAt", System.currentTimeMillis()).apply();
            renderCached(c, null);
        } catch (Exception e) {
            renderCached(c, "offline");
            throw e;
        }
    }

    /** Sofortige Rückmeldung beim Antippen des Pfeils. */
    static void showLoading(Context c) {
        try { renderCached(c, "lädt …"); } catch (Exception ignored) { }
    }

    /** Widget aus dem gemerkten Stand zeichnen. note: Hinweis statt Uhrzeit (z. B. "lädt …", "offline"). */
    static void renderCached(Context c, String note) throws Exception {
        AppWidgetManager mgr = AppWidgetManager.getInstance(c);
        int[] ids = mgr.getAppWidgetIds(new ComponentName(c, DepartureWidget.class));
        if (ids.length == 0) return;
        SharedPreferences p = StrabStore.prefs(c);
        JSONArray favs = new JSONArray(p.getString("favorites", "[]"));
        RemoteViews v = baseViews(c);
        if (favs.length() == 0) {
            v.setTextViewText(R.id.title, "STRABFAHRT");
            v.setTextViewText(R.id.stand, "");
            v.setViewVisibility(R.id.empty, View.VISIBLE);
            v.setTextViewText(R.id.empty, "Lege in der App eine Haltestelle als Favorit (★) an.");
            for (int i = 0; i < ROWS; i++) v.setViewVisibility(rowId(i), View.GONE);
            mgr.updateAppWidget(ids, v);
            return;
        }
        JSONObject fav = favs.getJSONObject(0);
        v.setTextViewText(R.id.title, fav.optString("name", "Abfahrten"));
        long at = p.getLong("widgetAt", 0);
        boolean have = at > 0 && fav.optString("id").equals(p.getString("widgetStop", ""));
        JSONObject res = have ? new JSONObject(p.getString("widgetData", "{}")) : new JSONObject();
        JSONArray deps = res.optJSONArray("departures");
        long now = System.currentTimeMillis();
        String time = have ? new SimpleDateFormat("HH:mm", Locale.GERMANY).format(new Date(at)) : "";
        String stand = note != null ? (have ? note + " · " + time : note) : (res.optBoolean("live") ? "● " : "") + time;
        v.setTextViewText(R.id.stand, stand);
        int shown = 0;
        for (int k = 0; deps != null && k < deps.length() && shown < ROWS; k++) {
            JSONObject d = deps.getJSONObject(k);
            // Seit dem Abruf abgefahren? Dann überspringen (eine Minute Kulanz)
            if (at + (d.optInt("min") + 1) * 60000L < now) continue;
            int i = shown++;
            v.setViewVisibility(rowId(i), View.VISIBLE);
            String line = d.optString("line");
            int bg = lineColor(d.optString("color"), d.optInt("type"), line);
            v.setTextViewText(id(c, "line", i), line);
            v.setInt(id(c, "line", i), "setBackgroundColor", bg);
            v.setTextColor(id(c, "line", i), readable(d.optString("textColor"), bg));
            v.setTextViewText(id(c, "dest", i), d.optString("dest"));
            String t = d.optString("time");
            int tc = Color.WHITE;
            if (d.optBoolean("canceled")) { t = "fällt aus"; tc = Color.parseColor("#FF6B6B"); }
            else if (!d.isNull("delay")) {
                int delay = d.optInt("delay");
                if (delay >= 1) { t = t + " +" + delay; tc = delay >= 3 ? Color.parseColor("#FF6B6B") : Color.parseColor("#FFD166"); }
                else if (delay <= -1) { t = t + " " + delay; tc = Color.parseColor("#8FD3FF"); }
            }
            v.setTextViewText(id(c, "time", i), t);
            v.setTextColor(id(c, "time", i), tc);
        }
        for (int i = shown; i < ROWS; i++) v.setViewVisibility(rowId(i), View.GONE);
        v.setViewVisibility(R.id.empty, shown == 0 ? View.VISIBLE : View.GONE);
        if (shown == 0) v.setTextViewText(R.id.empty, !have ? "Abfahrten werden geladen …" : "Keine Abfahrten in den nächsten Stunden.");
        mgr.updateAppWidget(ids, v);
    }

    static RemoteViews baseViews(Context c) {
        RemoteViews v = new RemoteViews(c.getPackageName(), R.layout.widget_departures);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        Intent open = new Intent(c, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        v.setOnClickPendingIntent(R.id.widget_root, PendingIntent.getActivity(c, 0, open, flags));
        Intent refresh = new Intent(c, DepartureWidget.class).setAction(DepartureWidget.ACTION_REFRESH);
        v.setOnClickPendingIntent(R.id.refresh, PendingIntent.getBroadcast(c, 1, refresh, flags));
        return v;
    }

    private static int rowId(int i) {
        switch (i) { case 0: return R.id.row0; case 1: return R.id.row1; case 2: return R.id.row2; case 3: return R.id.row3; default: return R.id.row4; }
    }

    private static int id(Context c, String name, int i) {
        return c.getResources().getIdentifier(name + i, "id", c.getPackageName());
    }

    static int lineColor(String hex, int type, String line) {
        if (hex != null && hex.matches("[0-9a-fA-F]{6}")) return Color.parseColor("#" + hex);
        if (type == 0 || type == 1) return Color.parseColor("#d1202e");
        if (type == 100) return Color.parseColor("#b71c1c");
        if (type == 3 || type == 11) return Color.parseColor("#7a3e98");
        if (type == 2) {
            if (line.matches("(?i)^(RE|RB|IRE|MEX|RS|FEX)\\d*.*")) return Color.parseColor("#1565c0");
            if (line.matches("(?i)^S\\d.*")) return Color.parseColor("#00796b");
            return Color.parseColor("#2a2a2a");
        }
        return Color.parseColor("#555555");
    }

    static int readable(String hex, int bg) {
        if (hex != null && hex.matches("[0-9a-fA-F]{6}")) return Color.parseColor("#" + hex);
        double lum = (0.299 * Color.red(bg) + 0.587 * Color.green(bg) + 0.114 * Color.blue(bg)) / 255;
        return lum > 0.6 ? Color.BLACK : Color.WHITE;
    }

    // ---------- Störungsmeldungen ----------

    static void checkAlerts(Context c) throws Exception {
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(c, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return;
        SharedPreferences p = StrabStore.prefs(c);
        JSONArray lines = new JSONArray(p.getString("lines", "[]"));
        JSONArray favs = new JSONArray(p.getString("favorites", "[]"));
        if (lines.length() == 0 && favs.length() == 0) return;
        List<Pattern> patterns = new ArrayList<>();
        for (int i = 0; i < lines.length(); i++) {
            String l = lines.getString(i).trim();
            if (l.matches("\\d{1,3}[A-Z]?")) {
                patterns.add(Pattern.compile("(Linie|Linien|Tram|Straßenbahn|Bus|Buslinie)[^.\\n]{0,60}\\b" + Pattern.quote(l) + "\\b"));
            } else if (l.length() >= 2) {
                patterns.add(Pattern.compile("\\b" + Pattern.quote(l) + "\\b"));
            }
        }
        for (int i = 0; i < favs.length(); i++) {
            String name = favs.getJSONObject(i).optString("name");
            if (name.length() >= 5) patterns.add(Pattern.compile(Pattern.quote(name), Pattern.CASE_INSENSITIVE));
        }
        JSONArray alerts = new JSONObject(get(StrabStore.base(c) + "/api/alerts")).optJSONArray("alerts");
        if (alerts == null) return;
        Set<String> seen = new HashSet<>(p.getStringSet("seenAlerts", new HashSet<>()));
        Set<String> current = new HashSet<>();
        int posted = 0;
        ensureChannel(c);
        for (int i = 0; i < alerts.length(); i++) {
            JSONObject a = alerts.getJSONObject(i);
            String id = a.optString("id");
            String header = a.optString("header");
            String text = a.optString("text");
            String all = header + "\n" + text;
            boolean match = false;
            for (Pattern pt : patterns) if (pt.matcher(all).find()) { match = true; break; }
            if (!match) continue;
            current.add(id);
            if (seen.contains(id) || posted >= 3) continue;
            posted++;
            Intent open = new Intent(c, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK).putExtra("openAlerts", true);
            PendingIntent pi = PendingIntent.getActivity(c, 100 + i, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            NotificationCompat.Builder b = new NotificationCompat.Builder(c, CHANNEL)
                .setSmallIcon(android.R.drawable.stat_notify_error)
                .setContentTitle(header.isEmpty() ? "Störung auf deinen Linien" : header)
                .setContentText(text.replaceAll("\\s+", " ").trim())
                .setStyle(new NotificationCompat.BigTextStyle().bigText(text.trim()))
                .setContentIntent(pi)
                .setAutoCancel(true)
                .setPriority(NotificationCompat.PRIORITY_DEFAULT);
            NotificationManagerCompat.from(c).notify(id.hashCode(), b.build());
            seen.add(id);
        }
        // Nur Meldungen merken, die noch aktiv sind, damit die Liste klein bleibt
        seen.retainAll(current);
        p.edit().putStringSet("seenAlerts", seen).apply();
    }

    static void ensureChannel(Context c) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationChannel ch = new NotificationChannel(CHANNEL, c.getString(R.string.channel_alerts), NotificationManager.IMPORTANCE_DEFAULT);
        ch.setDescription("Störungen und Bauarbeiten auf den Linien deiner Favoriten");
        c.getSystemService(NotificationManager.class).createNotificationChannel(ch);
    }

    // ---------- Netz ----------

    static String get(String url) throws Exception { return get(url, 15000, 30000); }

    static String get(String url, int connectMs, int readMs) throws Exception {
        HttpURLConnection con = (HttpURLConnection) new URL(url).openConnection();
        con.setConnectTimeout(connectMs);
        con.setReadTimeout(readMs);
        con.setRequestProperty("User-Agent", "STRABFAHRT-App");
        try {
            if (con.getResponseCode() != 200) throw new Exception("HTTP " + con.getResponseCode());
            StringBuilder sb = new StringBuilder();
            try (BufferedReader r = new BufferedReader(new InputStreamReader(con.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = r.readLine()) != null) sb.append(line).append('\n');
            }
            return sb.toString();
        } finally {
            con.disconnect();
        }
    }
}
