# Eigener MOTIS-Server für Umstiegsheld – Anleitung für Peter

Etwa 45 Minuten, dazu 1–3 Stunden Warten beim ersten Import.
**Schlüssel und Kennwörter nie in einen Chat kopieren** – nur auf den Server und ins Cloudflare-Dashboard.
Die Bezeichnungen in den Oberflächen von OVH und Cloudflare können leicht abweichen.

## 1. SSH-Schlüssel erzeugen (am eigenen PC, einmalig)

Windows: PowerShell öffnen und eingeben:

```
ssh-keygen -t ed25519 -C "umstiegsheld-server"
```

Dreimal Enter (oder ein Passwort vergeben). Dann den öffentlichen Teil anzeigen und kopieren:

```
Get-Content $env:USERPROFILE\.ssh\id_ed25519.pub
```

## 2. Server bei OVHcloud bestellen

1. Auf eco.ovhcloud.com einen **Rise-Server mit 64 GB RAM** wählen, Standort möglichst Deutschland (Limburg).
2. Betriebssystem: **Ubuntu Server 24.04**.
3. Bei „SSH-Schlüssel“ den kopierten öffentlichen Schlüssel aus Schritt 1 einfügen.
4. Nach der Bereitstellung (Mail von OVH) die **IP-Adresse** des Servers notieren.

## 3. Cloudflare: Tunnel anlegen

1. dash.cloudflare.com → **Zero Trust** → **Networks** → **Tunnels** → **Create a tunnel** → „Cloudflared“.
2. Name: `motis` → Speichern.
3. Bei der Installationsanzeige den langen **Token** kopieren (die Zeichenkette nach `--token`) und bereithalten.
   Die dort angezeigten Befehle selbst NICHT ausführen – das macht das Skript.
4. Weiter → **Public Hostname**: Subdomain `motis`, Domain `umstiegsheld.de`, Service **HTTP** → `localhost:8080` → Speichern.

## 4. Cloudflare: Zugang nur für den Worker

1. Zero Trust → **Access** → **Service Auth** → **Service Tokens** → **Create Service Token**, Name `umstiegsheld-worker`.
2. **Client ID** und **Client Secret** kopieren und sicher ablegen – das Secret wird nur einmal angezeigt.
3. Zero Trust → **Access** → **Applications** → **Add an application** → **Self-hosted**.
   Domain: `motis.umstiegsheld.de`. Policy: Aktion **Service Auth**, einschließen: **Service Token** `umstiegsheld-worker`.

## 5. Import-Kennwort festlegen

Ein langes Zufallskennwort ausdenken oder erzeugen (z. B. 40 Zeichen aus einem Passwortmanager).
Es kommt gleich auf den Server und in den Worker (als `OPS_KEY`).

## 6. Server einrichten (ein Befehl)

In PowerShell am PC:

```
ssh ubuntu@<IP-ADRESSE>
```

Dann auf dem Server:

```
curl -fsSL https://raw.githubusercontent.com/pseher/reisebegleiter/main/infra/motis/install.sh | sudo bash
```

Das Skript fragt nach dem **Tunnel-Token** (Schritt 3) und dem **Import-Kennwort** (Schritt 5).
Danach startet der erste Import im Hintergrund. Fortschritt ansehen (optional):

```
journalctl -fu motis-erst
```

Abmelden ist erlaubt (`exit`) – der Import läuft weiter.

## 7. Worker-Einstellungen (Cloudflare-Dashboard)

Workers & Pages → **reisebegleiter** → **Settings** → **Variables and Secrets** → hinzufügen:

| Name | Typ | Wert |
| --- | --- | --- |
| `MOTIS_URL` | Text | `https://motis.umstiegsheld.de` |
| `MOTIS_MODE` | Text | `test` (Testlauf; später auf `on`) |
| `MOTIS_ID` | Secret | Client ID aus Schritt 4 |
| `MOTIS_SECRET` | Secret | Client Secret aus Schritt 4 |
| `OPS_KEY` | Secret | Import-Kennwort aus Schritt 5 |
| `OPS_ACCOUNT` | Text | deine Konto-ID (bekommst du von Claude) – für Mitteilungen bei Ausfall |

Speichern/Deploy. Danach Claude Bescheid geben.

## Danach

- Auf umstiegsheld.de/admin zeigt die Ampel **Eigener Server**, ob er antwortet, wie oft ausgewichen wurde und den letzten Import.
- Fahrplan nachts, Karte monatlich, Echtzeit jede Minute und Sicherheitsupdates laufen automatisch.
- Fällt der Server aus, antwortet Transitous; nach 5 Minuten kommt eine Mitteilung aufs Handy.
  Meist hilft ein Neustart im OVH-Kundenportal.
