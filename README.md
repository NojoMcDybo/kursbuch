# Kursbuch

LearnWeb (Uni Münster) im Nojo-Ökosystem: ein Dashboard über die ganze Fensterbreite mit Zeitstrahl, Kalender, den Kursen
des gewählten Semesters und Fristen. Arbeitet auf den **lokalen** Daten des Syncs. Tauri v2 + Rust + Vanilla-TS, Design aus
`D:\Dev\nojo-design` (Kopie unter `src/nojo/`, aktualisieren mit
`powershell -File D:\Dev\nojo-design\tools\sync.ps1 -Only kursbuch`).

Auftrag und Entscheidungen: `C:\Users\nojod\learnweb-mcp\docs\desktop-app-prompt.md`.

## Aufbau der Oberfläche

```
┌ Leiste: Konto · Semester │ Notch-Zone (frei) │ Lupe · Fensterknöpfe ┐   auf dem farbigen Nebel
╭──────────────────── große matte Fläche, runde obere Ecken ───────────╮   schließt mit den Fensterrändern ab
│ Zeitstrahl                                                           │
│ Kurse │ Stundenplan                              │ Kalender          │
│       │                                          │ Abgaben           │
```

Liquid Glass tragen nur **Knöpfe und ausgewählte Elemente** (Konto, Semester, Lupe, Fensterknöpfe, Menüs, das Suchfenster);
alle Flächen und Karten sind matt (`--sheet`, `--card`). Jeder Kurs hat einen festen Farbton (`colors.rs`); der Nebel (`fog.ts`)
trägt die Farben des Semesters und ruht, solange das Suchfenster offen ist.

- **Konto** (`account.ts`, `account.rs`): Kreis oben links, Punkt = Sync-Stand (grün aktuell, gelb lange her, grau nicht angemeldet).
  Ohne Anmeldung ein Formular (Kennung, Passwort), sonst Kennung, letzter Sync und „Abmelden“. Das Passwort geht einmal per
  stdin an `learnweb.cli login`, das es bei LearnWeb prüft und im Windows-Tresor ablegt; die App behält nichts (das Feld wird
  sofort geleert), die Kennung wird geprüft (kein führendes Minus, keine Leerzeichen).
- **Semester** (`main.ts`): die zwei neuesten als Segmente, ältere hinter „…“ (dort steht dann der gewählte Name).
- **Suche**: Lupe oder Strg+K; das Fenster wächst aus der Lupe in die Mitte (Liquid Glass, Feld als Pille ohne eigene Farbe) und
  schließt sich in sie. Details unten.
- **Zeitstrahl** (`timeline.ts`): ohne Rahmen, minimalistisch. Fischauge: 14 Tage im Fokus mit Tagesraster, links Vergangenheit und
  rechts Zukunft logarithmisch gestaucht. Heute ist eine gefüllte Pille und ein hoher, weich leuchtender Strich über die ganze
  Höhe. Mausrad, Ziehen, Pfeile (Umschalt = Woche), Home/„Heute“ verschieben den Fokus; ein Tag im Kalender holt ihn in die Mitte.
- **Kurse** (`courses.ts`, links): die Kurse des gewählten Semesters; ein Klick öffnet den Kurs in einem **eigenen Fenster**.
  Hinter dem Kurs steht die Zahl neuer oder aktualisierter Aktivitäten, das Haken-Symbol setzt sie zurück.
- **Stundenplan** (`timetable.ts`, `timetable.rs`, Mitte): Woche Mo–Fr (Sa/So nur mit Einträgen), Stunden senkrecht, die
  Stundenhöhe wächst mit dem Fenster. Eintrag **selbst schreiben** (leere Stelle anklicken oder +), **importieren** (.ics; wöchentliche
  Ereignisse, einzelne Termine desselben Musters ab zwei Mal; Titel werden einem Kurs des Semesters zugeordnet, wenn genau einer
  passt; Übersprungenes wird gezählt) und **exportieren** (.ics in „Downloads“ mit wöchentlicher Wiederholung über einen wählbaren
  Zeitraum, Europe/Berlin samt VTIMEZONE, Kursname und LearnWeb-Link in der Beschreibung; für Apple und Google Kalender). Ein Klick
  auf einen Eintrag schiebt eine Karte nach vorn (wächst aus dem Eintrag): Zeit, Raum, Dozent, nächster Termin, Dateien, Neues,
  **Kurs** (Kursseite in Kursbuch) und **LearnWeb** (die echte Webseite), dazu Bearbeiten und Löschen. Gespeichert wird je Semester in
  `timetable.json` im App-Ordner (eine unlesbare Datei wird als `.defekt` beiseitegelegt, nie überschrieben).
- **Kalender, Abgaben** (`calendar.ts`, `abgaben.ts`, rechts, ohne Karte): Monatsraster mit Punkten je Kurs; darunter Fristen und
  Prüfungen der nächsten zwei Wochen mit Restzeit (unter 48 Stunden bernsteinfarben, überfällig rot).
- **Kursfenster** (`coursewin.ts`, `coursepage.ts`, `windows.rs`): `index.html?kurs=<id>` (`kurs-<id>` als Fenster, ein zweiter
  Klick holt es nach vorn und zeigt die gewünschte Stelle). Die Kursseite ist eine fortlaufende Seite ohne Karten; Zeilen:
  Datei öffnen, kopieren, laden („zu groß“ lädt ein Klick trotzdem); neue Aktivitäten tragen einen Punkt. Das Design der Kursseite
  wird noch einmal besprochen.
- **Suche** (`search.ts`, `search.rs`): durchsucht Namen von Kursen, Abschnitten und Aktivitäten und den Text aller Dateien (PDF,
  DOCX, PPTX, mit Seitenzahl) im Index der Python-Seite (`data/index.db`, nur lesend). **Schnell** sucht beim Tippen (alle Wörter,
  Wortanfänge), **Tief** erst mit Enter und weiter gefasst (Wortstämme, ein Wort genügt, Dokumente nach Dichte; die Neubewertung
  mit Laya kommt in Phase 5). **Semester | Alle** begrenzt auf die Kurse des gewählten Semesters. Treffer nach Kurs gruppiert,
  Ausschnitt mit Hervorhebung; Pfeile + Enter öffnen (Datei im Programm, sonst Kurs im Fenster mit blinkender Stelle), rechts „Datei
  kopieren“ und „Im Kurs zeigen“. Umlaute und ß werden wie im Index behandelt (ä = a, ß = ss).
- **Für KI** (`share.rs`): ✦ im Kopf eines Kurses kopiert die **Übersicht** (Auszug aus `_Verzeichnis.md`) oder **Übersicht + Text**
  (samt Text aller Dateien aus dem Index, höchstens 400 000 Zeichen) als Markdown. In der Suche kopiert ✦ die Treffer oder das ganze
  Verzeichnis oder öffnet es in Obsidian.
- **Größen**: ab 960 px drei Spalten; darunter werden Kalender und Abgaben eine Schublade (Knopf in der Leiste). F11 = Vollbild.
- **Notch** (`notch-align.ts`, `notch.rs`): Liegt die Notch über der Leiste, teilt sie sich links und rechts von ihr (Zone ab
  `--nz-x`, Breite `--nz-w`); seitlich angedockt halten Leiste und Fläche Abstand. Dazu die Karte `kursbuch:frist` (nächste Frist
  oder Prüfung).

## Daten (nur lesen)

```
LearnWeb ──(Python, learnweb-mcp)──► Vault (+ _Verzeichnis.md) + data/sync_state.json, deadlines.json, events.json, index.db
Kursbuch ──liest──► sync_state.json, sync_config.json, deadlines.json, events.json, index.db, _Verzeichnis.md
         ──startet──► `uv run python -m learnweb.cli fetch|login|logout|status …` (nur Python spricht mit LearnWeb und kennt Passwörter)
         ──schreibt──► nur im App-Ordner: colors.json, visits.json, timetable.json
         ──öffnet──► PDF in Folio, Office/Bilder/Audio im Standardprogramm, Links im Browser, Notiz in Obsidian
```

- `src-tauri/src/model.rs` Datenvertrag, Kursnamen in Titel/Semester/Dozent zerlegen (Semester einheitlich „WiSe 2026/27“)
- `data.rs` State lesen (zwischengespeichert), Kursraster und Kursansicht (Labels bleiben als Text)
- `events.rs` Termine: LearnWeb-Fristen und die aus Abschnittstiteln/Labels (Parser: `learnweb-mcp/learnweb/events.py`);
  dieselbe Frist in beiden Quellen gilt einmal (die von LearnWeb)
- `search.rs` Volltextsuche (SQLite FTS5 read-only; Eingaben wie `index.fts_query`: ß→ss, Wörter gequotet, höchstens 8) und
  Kurstext für die KI; `share.rs` „Für KI kopieren“ und Datei in die Zwischenablage; `fetch.rs` startet `learnweb.cli fetch`
- `timetable.rs` Stundenplan (Ablage, .ics schreiben und lesen), `account.rs` Anmeldung, `windows.rs` Kursfenster, `py.rs` Aufruf der
  Python-Seite (`uv run python -m learnweb.cli …`)
- `visits.rs` „Neu seit dem letzten Öffnen“, `colors.rs` Kursfarben, `notch.rs` Notch, `open.rs` Öffnen (nur IDs von der
  Oberfläche, Pfade unter dem Zielordner, PDFs direkt in Folio), `links.rs` Deep Link

Python-Projekt und `uv.exe` liegen standardmäßig unter `%USERPROFILE%\learnweb-mcp` und `%USERPROFILE%\.local\bin\uv.exe`
(überschreibbar über `settings.json` in `%APPDATA%\de.nojo.kursbuch`; dort schaltet `"notch": false` die Notch-Karte ab).
Zum Ausprobieren gegen Kopien: Umgebungsvariablen `KURSBUCH_PROJECT` (Projektordner), `KURSBUCH_CONFIG` (App-Ordner) und `KURSBUCH_DOWNLOADS`
(Zielordner des .ics-Exports; ohne sie zeigt der Export die Datei im Explorer).

## Deep Link

`kursbuch://heute` (Zeitstrahl und Kalender auf heute), `kursbuch://kurs/<id>` (Kursfenster öffnen),
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
- Umbau 2 (2026-10-14): Leiste + große matte Fläche, Liquid Glass nur für Knöpfe, Stundenplan (schreiben, .ics importieren/exportieren), Kurse in eigenen Fenstern, Konto-Anmeldung, Suchfenster aus der Lupe.
- Phase 5: KI (Laya): Termine und Fristen aus Folien als Vorschläge. Phase 6: Sync aus der App, Einstellungen, Installer.
