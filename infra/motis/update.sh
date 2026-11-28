#!/usr/bin/env bash
# Umstiegsheld – Fahrplan (nachts) bzw. Karte (monatlich) neu laden und ohne Ausfall umschalten.
#   update.sh fahrplan   → gtfs.de Fern-/Regional-/Nahverkehr neu laden (nur wenn geändert)
#   update.sh karte      → OpenStreetMap Deutschland neu laden
#   update.sh erst       → beim ersten Mal: alles laden und importieren
# Ablauf: Daten laden → im freien Ordner (Slot A/B) importieren → prüfen → umschalten → alten Slot behalten.
# Schlägt etwas fehl, läuft der Server mit dem bisherigen Stand weiter, und Umstiegsheld bekommt eine Meldung.
set -euo pipefail
WHAT="${1:-fahrplan}"
BASE=/srv/motis IN=/srv/motis/input BIN=/opt/motis/motis
source /etc/motis/ops.env   # OPS_KEY, REPORT_URL
START=$(date +%s)
log() { echo "[$(date "+%F %T")] $*" >&2; }
report() {  # ok(true/false) what msg
  curl -fsS -m 20 -X POST "$REPORT_URL" -H "Content-Type: application/json" -H "X-Ops-Key: $OPS_KEY" \
    -d "{\"ok\":$1,\"what\":\"$2\",\"msg\":\"$3\",\"secs\":$(( $(date +%s) - START )),\"feed\":\"$(date -r "$IN/gtfs-nv.zip" +%F 2>/dev/null || echo '?')\"}" >/dev/null || true
}
fail() { log "FEHLER: $*"; report false "$WHAT" "$*"; exit 1; }
trap 'fail "abgebrochen in Zeile $LINENO"' ERR

mkdir -p "$IN"
# Nur laden, wenn die Datei auf dem Server neuer ist (-z) – spart den Anbietern Bandbreite
get() { local url="$1" out="$2" cond=(); [ -f "$out" ] && cond=(-z "$out"); log "lade $url"
        curl -fsSL --retry 3 -A "Umstiegsheld/1.0 (+https://umstiegsheld.de)" "${cond[@]}" -o "$out.neu" "$url" >&2 || return 1
        if [ -s "$out.neu" ]; then mv "$out.neu" "$out"; echo neu; else rm -f "$out.neu"; fi; }

changed=""
if [ "$WHAT" = fahrplan ] || [ "$WHAT" = erst ]; then
  for t in fv rv nv; do c=$(get "https://download.gtfs.de/germany/${t}_free/latest.zip" "$IN/gtfs-$t.zip") || fail "Download Fahrplan $t"; changed+="$c"; done
fi
if [ "$WHAT" = karte ] || [ "$WHAT" = erst ]; then
  c=$(get "https://download.geofabrik.de/europe/germany-latest.osm.pbf" "$IN/germany-latest.osm.pbf") || fail "Download Karte"; changed+="$c"
fi
if [ -z "$changed" ] && [ "$WHAT" != erst ]; then log "nichts Neues – fertig"; report true "$WHAT" "unverändert"; exit 0; fi

# Freien Slot wählen: der, auf den "current" NICHT zeigt
cur=$(readlink -f "$BASE/current" 2>/dev/null || true)
if [ "$cur" = "$BASE/slot-a" ]; then nxt="$BASE/slot-b"; else nxt="$BASE/slot-a"; fi
log "importiere in $nxt (aktiv: ${cur:-keiner})"
rm -rf "$nxt"; mkdir -p "$nxt"
# Bisherige Importdaten mitnehmen: MOTIS rechnet dann nur neu, was sich geändert hat (Karte bleibt beim Fahrplan-Update)
if [ -n "$cur" ] && [ -d "$cur/data" ]; then cp -a "$cur/data" "$nxt/data"; fi
cp /opt/motis/config.yml "$nxt/config.yml"
[ -d /opt/motis/ui ] && ln -sfn /opt/motis/ui "$nxt/ui"
( cd "$nxt" && nice -n 10 "$BIN" import ) || fail "Import fehlgeschlagen ($WHAT)"

chown -R motis:motis "$nxt"
# Kurz auf einem Probe-Port starten und eine echte Suche machen, bevor umgeschaltet wird
sed -i 's/port: 8080/port: 8081/' "$nxt/config.yml"
( cd "$nxt" && exec sudo -u motis "$BIN" server ) & PROBE=$!
ok=""; for i in $(seq 1 90); do sleep 10
  if curl -fsS -m 10 "http://127.0.0.1:8081/api/v1/geocode?text=Berlin%20Hbf&type=STOP" | grep -q '"name"'; then ok=1; break; fi
  kill -0 $PROBE 2>/dev/null || break; done
kill $PROBE 2>/dev/null || true; wait $PROBE 2>/dev/null || true; sed -i 's/port: 8081/port: 8080/' "$nxt/config.yml"
[ -n "$ok" ] || fail "neuer Stand antwortet nicht – bleibe beim alten"

ln -sfn "$nxt" "$BASE/current.neu" && mv -T "$BASE/current.neu" "$BASE/current"
systemctl restart motis
for i in $(seq 1 90); do sleep 10; curl -fsS -m 10 "http://127.0.0.1:8080/api/v1/geocode?text=Berlin%20Hbf&type=STOP" | grep -q '"name"' && break; done
log "umgeschaltet auf $nxt"
report true "$WHAT" "umgeschaltet auf $(basename "$nxt")"
