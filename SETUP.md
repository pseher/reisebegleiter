# Reisebegleiter – Einrichtung

Ein Cloudflare Worker liefert App und Schnittstelle unter einer Adresse und prüft jede Minute die laufenden Reisen.
Daten liegen im PlanFlink-Supabase-Projekt in eigenen Tabellen (`rb_…`). Geheime Schlüssel kommen **nie** ins Repo und nie in den Chat.

## 1 · Supabase-Tabellen (2 Min.)
Supabase → PlanFlink-Projekt → **SQL Editor** → Inhalt von `supabase/schema.sql` einfügen → **Run**.
Legt nur `rb_devices` und `rb_trips` an, PlanFlink bleibt unberührt.

## 2 · DB API Marketplace (2 Min.)
In der Anwendung, die PlanFlink nutzt, zusätzlich **OpenBoards** (Free) abonnieren.
Timetables bleibt abonniert – darüber läuft vorerst die Bahnhofssuche.

## 3 · Worker anlegen (10 Min.)
1. Cloudflare → **Workers & Pages** → **Erstellen** → **Worker importieren / Mit Git verbinden** → Repo `pseher/reisebegleiter`
   (Build-Befehl leer, Deploy-Befehl `npx wrangler deploy`). Ab dann wird bei jedem Push automatisch bereitgestellt.
2. **Einstellungen → Variablen und Geheimnisse** → als **Secret**:
   - `SUPABASE_SERVICE_KEY` – derselbe Secret Key wie beim PlanFlink-Worker
   - `DB_CLIENT_ID`, `DB_API_KEY` – dieselben wie bei PlanFlink
   - `VAPID_JWK` – denselben Wert wie bei PlanFlink übernehmen oder neu erzeugen: `node tools/vapid.mjs`
3. Adresse aufrufen (z. B. `https://reisebegleiter.<konto>.workers.dev`), Reise anlegen, Mitteilungen erlauben.
   Eigene Domain später unter **Einstellungen → Domains & Routen**.

## Prüfen, ob alles läuft
- Cloudflare → Worker → **Logs**: jede Minute eine Zeile `Lauf: {"trips":…,"checks":…,"requests":…}`.
- Rohdaten von OpenBoards (nach dem ersten Öffnen der App, mit Geräte-Schlüssel):
  `/api/debug/board?eva=8011160&kind=dep` – hilft, falls eine Angabe falsch angezeigt wird.

## Lokal ausprobieren (ohne Schlüssel, mit Testdaten)
```
npm test        # Logik-Tests
npm run dev     # http://localhost:8787, Testzüge Berlin → Leipzig → München
```
Cron sofort auslösen, auch mit Zeitsprung: `curl "localhost:8787/api/mock/tick?plus=30"` – Meldungen stehen im Terminal.

## Grenzen im kostenlosen Cloudflare-Tarif
50 externe Abfragen pro Lauf und 10 ms Rechenzeit. Für den Familientest reicht das; bei vielen Reisen
den Workers-Paid-Tarif (5 $/Monat) nehmen.
