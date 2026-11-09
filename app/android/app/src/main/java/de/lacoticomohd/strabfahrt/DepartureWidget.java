package de.lacoticomohd.strabfahrt;

import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.content.Intent;

/** Startbildschirm-Widget: nächste Abfahrten am ersten Favoriten. */
public class DepartureWidget extends AppWidgetProvider {
    static final String ACTION_REFRESH = "de.lacoticomohd.strabfahrt.WIDGET_REFRESH";
    static final String ACTION_TICK = "de.lacoticomohd.strabfahrt.WIDGET_TICK";

    @Override
    public void onUpdate(Context c, AppWidgetManager mgr, int[] ids) {
        // Letzten Stand sofort zeigen, dann frisch laden (läuft im Hintergrund weiter)
        StrabStore.schedule(c);
        StrabStore.scheduleTick(c);
        StrabStore.refreshAsync(c.getApplicationContext(), goAsync(), false);
    }

    @Override
    public void onEnabled(Context c) {
        StrabStore.scheduleTick(c);
    }

    @Override
    public void onDisabled(Context c) {
        StrabStore.scheduleTick(c); // ohne Widget wird der Wecker dort abgestellt
    }

    @Override
    public void onReceive(Context c, Intent intent) {
        String action = intent.getAction();
        if (ACTION_REFRESH.equals(action)) {
            StrabStore.scheduleTick(c);
            StrabStore.refreshAsync(c.getApplicationContext(), goAsync(), true);
            return;
        }
        if (ACTION_TICK.equals(action)) {
            StrabStore.scheduleTick(c);
            StrabStore.refreshAsync(c.getApplicationContext(), goAsync(), false);
            return;
        }
        super.onReceive(c, intent);
    }
}
