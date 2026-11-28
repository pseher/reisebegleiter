#!/usr/bin/env bash
# Umstiegsheld – eigener MOTIS-Server, Einrichtung in einem Durchgang (Ubuntu 24.04, als root bzw. mit sudo).
#   curl -fsSL https://raw.githubusercontent.com/pseher/reisebegleiter/main/infra/motis/install.sh | sudo bash
# Fragt den Cloudflare-Tunnel-Schlüssel und das Import-Kennwort ab (werden nur auf diesem Server gespeichert).
set -euo pipefail
REPO=https://raw.githubusercontent.com/pseher/reisebegleiter/main/infra/motis
[ "$(id -u)" = 0 ] || { echo "Bitte mit sudo starten."; exit 1; }
say() { echo; echo "==> $*"; }

say "Abfragen (Eingabe wird nicht angezeigt)"
read -rsp "Cloudflare-Tunnel-Schlüssel (aus Zero Trust → Tunnels): " TUNNEL_TOKEN </dev/tty; echo
read -rsp "Import-Kennwort (dasselbe wie OPS_KEY im Worker): " OPS_KEY </dev/tty; echo
[ -n "$TUNNEL_TOKEN" ] && [ -n "$OPS_KEY" ] || { echo "Beides wird gebraucht."; exit 1; }

say "System aktualisieren, Sicherheitsupdates automatisch, Firewall nur für SSH"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q && apt-get -yq upgrade
apt-get install -yq curl bzip2 ca-certificates unattended-upgrades ufw python3
dpkg-reconfigure -f noninteractive unattended-upgrades
ufw allow OpenSSH && ufw --force enable

say "MOTIS installieren (neueste Version)"
id motis >/dev/null 2>&1 || useradd --system --home /srv/motis --shell /usr/sbin/nologin motis
mkdir -p /opt/motis /srv/motis/input /srv/motis/rt /etc/motis
curl -fsSL -o /tmp/motis.tar.bz2 https://github.com/motis-project/motis/releases/latest/download/motis-linux-amd64.tar.bz2
tar -xjf /tmp/motis.tar.bz2 -C /opt/motis --strip-components=0
[ -x /opt/motis/motis ] || mv /opt/motis/*/motis /opt/motis/ 2>/dev/null || true
[ -x /opt/motis/motis ] || { echo "MOTIS-Programm nicht gefunden – bitte Claude Bescheid geben."; exit 1; }
curl -fsSL -o /opt/motis/config.yml "$REPO/config.template.yml"
curl -fsSL -o /opt/motis/update.sh "$REPO/update.sh" && chmod +x /opt/motis/update.sh
umask 077; printf 'OPS_KEY=%s\nREPORT_URL=https://umstiegsheld.de/api/ops/motis\n' "$OPS_KEY" > /etc/motis/ops.env; umask 022
chown -R motis:motis /srv/motis

say "Dienste einrichten"
cat > /etc/systemd/system/motis.service <<'U'
[Unit]
Description=MOTIS (Umstiegsheld)
After=network-online.target motis-rt.service
[Service]
User=motis
WorkingDirectory=/srv/motis/current
ExecStart=/opt/motis/motis server
Restart=always
RestartSec=10
LimitNOFILE=65536
[Install]
WantedBy=multi-user.target
U
# Echtzeit: einmal pro Minute bei gtfs.de holen, lokal an MOTIS verteilen
cat > /etc/systemd/system/motis-rt.service <<'U'
[Unit]
Description=Echtzeit-Datei lokal bereitstellen (Umstiegsheld)
[Service]
User=motis
WorkingDirectory=/srv/motis/rt
ExecStart=/usr/bin/python3 -m http.server 8090 --bind 127.0.0.1
Restart=always
[Install]
WantedBy=multi-user.target
U
cat > /etc/systemd/system/motis-rt-fetch.service <<'U'
[Unit]
Description=Echtzeit von gtfs.de holen (Umstiegsheld)
[Service]
Type=oneshot
User=motis
ExecStart=/bin/sh -c 'curl -fsS -m 50 -A "Umstiegsheld/1.0 (+https://umstiegsheld.de)" -z /srv/motis/rt/realtime.pb -o /srv/motis/rt/realtime.tmp https://realtime.gtfs.de/realtime-free.pb && { [ -s /srv/motis/rt/realtime.tmp ] && mv /srv/motis/rt/realtime.tmp /srv/motis/rt/realtime.pb || rm -f /srv/motis/rt/realtime.tmp; }'
U
cat > /etc/systemd/system/motis-rt-fetch.timer <<'U'
[Unit]
Description=Echtzeit jede Minute
[Timer]
OnBootSec=30
OnUnitActiveSec=60
AccuracySec=5
[Install]
WantedBy=timers.target
U
# Fahrplan nachts 03:20, Karte am 3. jeden Monats 02:10 (Import mit Speicherobergrenze, damit der laufende Server nicht leidet)
for kind in fahrplan karte erst; do
cat > /etc/systemd/system/motis-$kind.service <<U
[Unit]
Description=MOTIS $kind aktualisieren (Umstiegsheld)
[Service]
Type=oneshot
ExecStart=/opt/motis/update.sh $kind
MemoryMax=44G
TimeoutStartSec=6h
U
done
cat > /etc/systemd/system/motis-fahrplan.timer <<'U'
[Unit]
Description=Fahrplan jede Nacht
[Timer]
OnCalendar=*-*-* 03:20
RandomizedDelaySec=600
Persistent=true
[Install]
WantedBy=timers.target
U
cat > /etc/systemd/system/motis-karte.timer <<'U'
[Unit]
Description=Karte einmal im Monat
[Timer]
OnCalendar=*-*-03 02:10
Persistent=true
[Install]
WantedBy=timers.target
U
systemctl daemon-reload
systemctl enable --now motis-rt.service motis-rt-fetch.timer
systemctl enable motis.service motis-fahrplan.timer motis-karte.timer

say "Cloudflare-Tunnel einrichten"
mkdir -p --mode=0755 /usr/share/keyrings
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o /usr/share/keyrings/cloudflare-main.gpg
echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' > /etc/apt/sources.list.d/cloudflared.list
apt-get update -q && apt-get install -yq cloudflared
cloudflared service install "$TUNNEL_TOKEN" || systemctl restart cloudflared

say "Erster Import startet jetzt im Hintergrund (1–3 Stunden)"
systemctl start --no-block motis-erst.service
cat <<T

Fertig eingerichtet. Der erste Import läuft im Hintergrund – du kannst dich abmelden.
Fortschritt ansehen:   journalctl -fu motis-erst
Danach läuft alles von selbst; auf umstiegsheld.de/admin zeigt die Ampel „Eigener Server“ den Stand.
T
