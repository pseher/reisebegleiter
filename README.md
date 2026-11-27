# Reisebegleiter

Bahnfahren ohne Stress: Die App überwacht eine Reise, erkennt gefährdete Anschlüsse vorher, hält einen Plan B bereit
und meldet sich nur, wenn der Reisende etwas tun sollte. Kein Ticketverkauf, keine Buchung.

| Teil | Datei |
| --- | --- |
| Entscheidungslogik (Umstiegsreserve, Status, Meldungen) | `src/engine.js` |
| DB OpenBoards (Abfahrten/Ankünfte, Echtzeit) | `src/openboards.js` |
| Überwachung per Cron, Plan B, Push | `src/monitor.js` |
| Schnittstelle für die App | `src/worker.js` |
| App (PWA, Vanilla JS) | `public/` |
| Tabellen | `supabase/schema.sql` |

Einrichtung: siehe `SETUP.md`. Konzept: Dokument „Reisebegleiter – Funktionskonzept“ im Projekt.
Echtzeitdaten: DB InfraGO (OpenBoards), VBB. Verbindungssuche: [Transitous](https://transitous.org/sources/) (MOTIS, offene Fahrplandaten), Orts- und Wegedaten © [OpenStreetMap-Mitwirkende](https://www.openstreetmap.org/copyright). Angaben ohne Gewähr.

## Lizenz

Umstiegsheld ist freie Software unter der **GNU Affero General Public License v3.0 oder später** (siehe `LICENSE`).
Wer den Code verändert und als Dienst betreibt, muss den geänderten Quellcode den Nutzern ebenfalls zugänglich machen.
