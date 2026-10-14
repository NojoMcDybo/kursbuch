# Kursbuch

LearnWeb (Uni Münster) im Nojo-Ökosystem: ein Dashboard über die ganze Fensterbreite mit Zeitstrahl, Kalender, den Kursen
des gewählten Semesters und Fristen. Arbeitet auf den **lokalen** Daten des Syncs. Tauri v2 + Rust + Vanilla-TS, Design aus
`D:\Dev\nojo-design` (Kopie unter `src/nojo/`, aktualisieren mit
`powershell -File D:\Dev\nojo-design\tools\sync.ps1 -Only kursbuch`).

Auftrag und Entscheidungen: `C:\Users\nojod\learnweb-mcp\docs\desktop-app-prompt.md`.

## Aufbau der Oberfläche

```
┌ Kopf: Marke · Semester │ Notch-Zone (frei) │ Sync-Stand · Fensterknöpfe ┐
├ Zeitstrahl: zwei Wochen im Tagesraster, nach außen gestaucht, scrollbar ┤
├ Kalender + Agenda │ Kurs-Chips + geöffnete Kurse nebeneinander │ Fristen, Neu ┤
```

- **Zeitstrahl** (`timeline.ts`): Fischauge. 14 Tage im Fokus mit Tagesraster, links Vergangenheit und rechts Zukunft
  logarithmisch gestaucht (Wochenstriche, dann Monate bis etwa elf Monate voraus). Mausrad, Ziehen, Pfeile (Umschalt =
  Woche), Home/„Heute“ verschieben den Fokus; ein Tag im Kalender holt ihn in die Mitte. Im Fokus alle Termine, außerhalb nur
  Fristen und Prüfungen als Punkte.
- **Kalender, Agenda** (`calendar.ts`, `agenda.ts`), **Fristen und Neu** (`side.ts`): Fristen mit Restzeit (volle Kalendertage,
  unter 48 Stunden bernsteinfarben, überfällig rot); „Neu“ bleibt für die Sitzung stehen, „Gelesen“ setzt zurück.
- **Mitte** (`courses.ts`): Chips für die Kurse des Semesters (schneller Wechsel). Geöffnete Kurse stehen als fortlaufende Seiten
  nebeneinander (so viele, wie in die Breite passen, mindestens 500 px, sonst seitlich blättern); ohne offenen Kurs Kacheln.
- **Suche** (`search.ts`, `search.rs`): Strg+K oder die Lupe im Kopf, Glas-Overlay. Sucht Namen von Kursen, Abschnitten und
  Aktivitäten und den Text aller Dateien (PDF, DOCX, PPTX, mit Seitenzahl) im Index der Python-Seite (`data/index.db`, nur
  lesend). **Schnell** sucht beim Tippen (alle Wörter, Wortanfänge), **Tief** erst mit Enter und weiter gefasst (Wortstämme,
  ein Wort genügt, Dokumente nach Dichte geordnet; die Neubewertung mit Laya kommt in Phase 5). **Semester | Alle** begrenzt
  auf die Kurse des gewählten Semesters. Treffer nach Kurs gruppiert, Ausschnitt mit Hervorhebung; Pfeile + Enter öffnen
  (Datei im Programm, sonst Kurs mit blinkender Stelle), rechts „Datei kopieren“ und „Im Kurs zeigen“. Die Wahl bleibt
  gespeichert. Umlaute und ß werden wie im Index behandelt (ä = a, ß = ss).
- **Für KI** (`share.rs`): Das Symbol ✦ im Kopf eines Kurses kopiert die **Übersicht** (Auszug aus `_Verzeichnis.md`: Abschnitte,
  Dateien, Seiten, Textanfänge) oder **Übersicht + Text** (samt Text aller Dateien aus dem Index, höchstens 400 000 Zeichen) als
  Markdown in die Zwischenablage. In der Suche kopiert ✦ die Treffer oder das ganze Verzeichnis oder öffnet es in Obsidian.
- **Dateien**: Zeile zeigen = Symbole am Rand: Datei kopieren (als Datei in die Zwischenablage, zum Einfügen als Anhang). Fehlt
  eine Datei, steht dort „Laden“; ist sie als „zu groß“ vermerkt, lädt ein Klick auf die Zeile sie trotzdem. Geladen wird über
  die Python-Seite (`cli fetch`, `fetch.rs`), die State, Kursnotiz, Index und Verzeichnis nachzieht; die Oberfläche
  aktualisiert sich danach von selbst.
- **Farbe**: Jeder Kurs hat einen festen Farbton (`colors.rs`), der Nebel (`fog.ts`) trägt die Farben des Semesters, geöffnete
  Kurse betont. Glas: kleine Elemente sind Liquid Glass mit Brechung (`.n-liquid`), große Flächen Nojo-Glas mit Lichtkante
  (`.n-glass.big`). Die Brechung auf großen Flächen kostete bei bewegtem Nebel mehr als 30 % eines CPU-Kerns im Leerlauf.
- **Größen**: ab 1360 px drei Spalten (links Kalender, rechts Fristen), 960–1359 px der Kalender unter den Fristen, darunter
  werden beide Seiten Schubladen (Knöpfe im Kopf). F11 = Vollbild.
- **Notch** (`notch-align.ts`, `notch.rs`): Liegt die Notch über dem Kopf, teilt er sich links und rechts von ihr (Zone ab
  `--nz-x`, Breite `--nz-w`); seitlich angedockt halten Kopf, Zeitstrahl und Inhalt Abstand. Die aufgeklappte Notch ist
  vorübergehend größer und darf den Inhalt kurz überdecken. Dazu die Karte `kursbuch:frist` (nächste Frist oder Prüfung).

## Daten (nur lesen)

```
LearnWeb ──(Python, learnweb-mcp)──► Vault (+ _Verzeichnis.md) + data/sync_state.json, deadlines.json, events.json, index.db
Kursbuch ──liest──► sync_state.json, sync_config.json, deadlines.json, events.json, index.db, _Verzeichnis.md
         ──startet──► `uv run python -m learnweb.cli fetch <kurs> <cmid>` (Sofort-Download; nur Python spricht mit LearnWeb)
         (kein Passwort in der App)
         ──öffnet──► PDF in Folio, Office/Bilder/Audio im Standardprogramm, Links im Browser, Notiz in Obsidian
```

- `src-tauri/src/model.rs` Datenvertrag, Kursnamen in Titel/Semester/Dozent zerlegen (Semester einheitlich „WiSe 2026/27“)
- `data.rs` State lesen (zwischengespeichert), Kursraster und Kursansicht (Labels bleiben als Text)
- `events.rs` Termine: LearnWeb-Fristen und die aus Abschnittstiteln/Labels (Parser: `learnweb-mcp/learnweb/events.py`);
  dieselbe Frist in beiden Quellen gilt einmal (die von LearnWeb)
- `search.rs` Volltextsuche (SQLite FTS5 read-only; Eingaben wie `index.fts_query`: ß→ss, Wörter gequotet, höchstens 8) und
  Kurstext für die KI; `share.rs` „Für KI kopieren“ und Datei in die Zwischenablage; `fetch.rs` startet `learnweb.cli fetch`
- `visits.rs` „Neu seit dem letzten Öffnen“, `colors.rs` Kursfarben, `notch.rs` Notch, `open.rs` Öffnen (nur IDs von der
  Oberfläche, Pfade unter dem Zielordner, PDFs direkt in Folio), `links.rs` Deep Link

Python-Projekt und `uv.exe` liegen standardmäßig unter `%USERPROFILE%\learnweb-mcp` und `%USERPROFILE%\.local\bin\uv.exe`
(überschreibbar über `settings.json` in `%APPDATA%\de.nojo.kursbuch`; dort schaltet `"notch": false` die Notch-Karte ab).
Zum Ausprobieren gegen Kopien: Umgebungsvariablen `KURSBUCH_PROJECT` (Projektordner) und `KURSBUCH_CONFIG` (App-Ordner).

## Deep Link

`kursbuch://heute` (Zeitstrahl und Kalender auf heute), `kursbuch://kurs/<id>` (Kurs öffnen, Semester wählen),
`kursbuch://suche/<Begriff>` (Suche öffnen und ausführen). Ein Link darf nur **navigieren**; alles Verformte wird ignoriert. Ein zweiter Start
reicht ihn an die laufende App weiter. Die App meldet das Schema beim Start an (im Entwicklungsbetrieb: `target\debug`).

## Entwickeln

```powershell
npm install        # .npmrc schaltet devDependencies ein (NODE_ENV=production wird von der Claude-App vererbt)
npm run tauri dev
cargo test --manifest-path src-tauri/Cargo.toml
```

## Stand

- Phase 2: Gerüst, Öffnen, Deep Link. Phase 3: Dashboard-Umbau (Zeitstrahl, Kalender, Semester, Kursseiten, Notch, Farben).
- Phase 4: Suche (Volltext, „Tief“), Verzeichnis für Claude/ChatGPT (`_Verzeichnis.md`), „Für KI kopieren“, Sofort-Download.
- Phase 5: KI (Laya): Termine und Fristen aus Folien als Vorschläge. Phase 6: Sync aus der App, Einstellungen, Installer.
