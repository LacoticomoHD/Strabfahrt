#!/bin/sh
# Naechtlich per cron: Fahrplaene neu bauen und den Dienst neu starten. Bricht ab, ohne die alten Daten zu ersetzen,
# wenn der Bau oder die Pruefung scheitert.
#   crontab -e  ->  17 3 * * * /home/pi/Strabfahrt/deploy/update.sh >> /home/pi/strabfahrt-update.log 2>&1
set -e
cd "$(dirname "$0")/.."
export NODE_OPTIONS=--max-old-space-size=4096
STRAB_DATA_DIR=data/next node scripts/build-data.mjs
STRAB_DATA_DIR=data/next node scripts/check-data.mjs
cp data/next/model.json data/next/rt-map.json data/
rm -f data/shapes.json   # passt nicht mehr zum neuen Modell, bei Bedarf: npm run snap:rail
sudo systemctl restart strabfahrt
