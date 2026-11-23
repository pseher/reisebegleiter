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
Echtzeitdaten: DB InfraGO (OpenBoards). Angaben ohne Gewähr.
