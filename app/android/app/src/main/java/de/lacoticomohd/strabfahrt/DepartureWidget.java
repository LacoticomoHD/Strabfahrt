package de.lacoticomohd.strabfahrt;

import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.content.Intent;

/** Startbildschirm-Widget: nächste Abfahrten am ersten Favoriten. */
public class DepartureWidget extends AppWidgetProvider {
    static final String ACTION_REFRESH = "de.lacoticomohd.strabfahrt.WIDGET_REFRESH";

    @Override
    public void onUpdate(Context c, AppWidgetManager mgr, int[] ids) {
        mgr.updateAppWidget(ids, StrabWorker.baseViews(c));
        StrabStore.schedule(c);
        StrabStore.refreshNow(c);
    }

    @Override
    public void onReceive(Context c, Intent intent) {
        super.onReceive(c, intent);
        if (ACTION_REFRESH.equals(intent.getAction())) StrabStore.refreshNow(c);
    }
}
