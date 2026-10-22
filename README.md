# Kursbuch

LearnWeb (Uni Münster) im Nojo-Ökosystem: ein Dashboard über die ganze Fensterbreite mit Zeitstrahl, Wochenkalender samt Stundenplan, den Kursen
des gewählten Semesters und Fristen. Arbeitet auf den **lokalen** Daten des Syncs. Tauri v2 + Rust + Vanilla-TS, Design aus
`D:\Dev\nojo-design` (Kopie unter `src/nojo/`, aktualisieren mit
`powershell -File D:\Dev\nojo-design\tools\sync.ps1 -Only kursbuch`).

Auftrag und Entscheidungen stehen im privaten Entwicklungsordner der Python-Seite.

## Aufbau der Oberfläche

```
┌ Leiste: Konto · Semester │ Notch-Zone (frei) │ Lupe · Fensterknöpfe ┐   auf dem farbigen Nebel
╭──────────────────── große matte Fläche, runde obere Ecken ───────────╮   schließt mit den Fensterrändern ab
│ Zeitstrahl                                                           │
│ Kurse │ Stundenplan + Wochenkalender (eine Woche)│ Abgaben           │
```

Liquid Glass tragen nur **Knöpfe und ausgewählte Elemente** (Konto, Semester, Lupe, Fensterknöpfe, Menüs, das Suchfenster) und der **Zeitstrahl** als Glasfläche; alle Module der Leiste sind gleich groß wie die Fensterpille (38 px hoch);
alle Flächen und Karten sind matt (`--sheet`, `--card`). Jeder Kurs hat einen festen Farbton (`colors.rs`); der Nebel (`fog.ts`)
trägt die Farben des Semesters und ruht, solange das Suchfenster offen ist.

- **Konto** (`account.ts`, `account.rs`): Kreis oben links, Punkt = Sync-Stand (grün aktuell, gelb lange her, grau nicht angemeldet).
  Ohne Anmeldung ein Formular (Kennung, Passwort), sonst Kennung, letzter Sync und „Abmelden“. Das Passwort geht einmal per
  stdin an `learnweb.cli login`, das es bei LearnWeb prüft und im Windows-Tresor ablegt; das Feld wird sofort geleert. Mit dem Haken
  **„Passwort speichern“** (Vorgabe) bleibt es im Tresor; ohne Haken prüft Kursbuch es nur und hält es bis zum Abmelden oder Beenden im
  Speicher (Syncs bekommen es per stdin, `--password-stdin`); der Tresor, der geplante Sync und der MCP-Server bleiben unberührt, die Kennung wird geprüft (kein führendes Minus, keine Leerzeichen).
- **Semester** (`main.ts`): die zwei neuesten als Segmente, ältere hinter „…“ (dort steht dann der gewählte Name).
- **Suche**: Lupe oder Strg+K; das Fenster wächst aus der Lupe in die Mitte (Liquid Glass, Feld als Pille ohne eigene Farbe) und
  schließt sich in sie. Details unten.
- **Zeitstrahl** (`timeline.ts`): ohne Rahmen, minimalistisch. Fischauge: 14 Tage im Fokus mit Tagesraster, links Vergangenheit und
  rechts Zukunft logarithmisch gestaucht. Heute ist eine gefüllte Pille und ein hoher, weich leuchtender Strich über die ganze
  Höhe. Mausrad, Ziehen, Pfeile (Umschalt = Woche), Home/„Heute“ verschieben den Fokus; ein Tag im Wochenkalender holt ihn in die Mitte.
- **Kurse** (`courses.ts`, links): die Kurse des gewählten Semesters; ein Klick öffnet den Kurs **im gleichen Fenster** als Layer (s. u.).
  Hinter dem Kurs steht die Zahl neuer oder aktualisierter Aktivitäten, das Haken-Symbol setzt sie zurück.
- **Stundenplan und Wochenkalender in einem** (`timetable.ts`, `timetable.rs`, Mitte): immer **eine Woche**, anfangs die aktuelle, mit Pfeilen,
  Kalenderwoche und „Heute“ (die Zahl eines Tages holt ihn in den Zeitstrahl). Mo–Fr stehen immer da, **Samstag und Sonntag schieben sich ein**,
  sobald dort ein Eintrag oder Termin liegt (oder heute ist). Der **wöchentliche Stundenplan** steht in jeder Woche als Blöcke (Stunden senkrecht,
  die Stundenhöhe wächst mit dem Fenster), die **Termine von LearnWeb** dieser Woche als Pillen unter dem Tag (Kursfarbe, Klick öffnet den Kurs).
  Eintrag **selbst schreiben** (leere Stelle anklicken oder +), **importieren** (.ics; wöchentliche
  Ereignisse, einzelne Termine desselben Musters ab zwei Mal; Titel werden einem Kurs des Semesters zugeordnet, wenn genau einer
  passt; Übersprungenes wird gezählt) und **exportieren** (.ics in „Downloads“ mit wöchentlicher Wiederholung über einen wählbaren
  Zeitraum, Europe/Berlin samt VTIMEZONE, Kursname und LearnWeb-Link in der Beschreibung; für Apple und Google Kalender). Ein Klick
  auf einen Eintrag schiebt eine Karte nach vorn (wächst aus dem Eintrag): Zeit, Raum, Dozent, nächster Termin, Dateien, Neues,
  **Kurs** (Kursseite in Kursbuch) und **LearnWeb** (die echte Webseite), dazu Bearbeiten und Löschen. Gespeichert wird je Semester in
  `timetable.json` im App-Ordner (eine unlesbare Datei wird als `.defekt` beiseitegelegt, nie überschrieben).
- **Abgaben** (`abgaben.ts`, rechts, ohne Karte): Fristen und Prüfungen der nächsten zwei Wochen mit Restzeit (unter 48 Stunden
  bernsteinfarben, überfällig rot).
- **Kurse per Ziehen zuordnen** (`drag.ts`): Eine Zeile der Kursliste lässt sich auf einen Eintrag im Stundenplan ziehen (z. B. nach einem
  .ics-Import, wo die Einträge grau und ohne Kurs sind). Die Zeile hebt sich ab und folgt dem Zeiger als Karte in der Kursfarbe, Einträge
  ohne Kurs pulsieren, der Eintrag darunter leuchtet in der Kursfarbe; beim Loslassen fliegt die Karte hinein, der Eintrag atmet auf und
  nimmt die Farbe an („Rückgängig“ in der Meldung stellt nur diesen Eintrag zurück). Daneben federt die Karte zurück, Esc bricht ab, am
  Rand des Plans blättert er. Ein Klick ohne Ziehen öffnet weiter den Kurs. Über das Formular (Kurs-Auswahl) geht es weiterhin mit der Tastatur.
- **Vorschläge aus den Kurstexten** (Phase 5; `learnweb/suggest.py`, `suggestions.rs`): Aus dem Suchindex (Folien, Dokumente, Ankündigungen, Aufgabentexte)
  zieht der Sync Termine und Fristen, die dort nur im Text stehen (Klausurtermin auf einer Folie, „Abgabe bis …“, Anmeldephase). Ein Datum zählt nur mit
  einem Stichwort in der Nähe (Prüfung/Klausur, Abgabe/Frist/bis, Symposium/Workshop/Beginn), das zu **diesem** Datum gehört, ohne Download-Stempel,
  Literaturangaben oder Abschnittsnummern, im Zeitfenster von gestern bis +300 Tagen und im Semester des Kurses (ohne Jahresangabe zählt das passende Jahr).
  Sie erscheinen **gestrichelt** im Zeitstrahl und in der Woche (nie in den Abgaben oder der Notch); ein Klick fragt „Als Termin übernehmen“ oder „Verwerfen“
  (kommt nicht wieder) und nennt Quelle und Sicherheit. Gemessen: Regeln ordnen zu rund 80 % richtig ein; **Laya** (Zero-Shot, englisches Modell) war nicht
  besser und mit 2–6 s je Textstelle langsam – Messung in `learnweb-mcp/docs/phase5-laya-messung.md`. **Laya ist draußen** (Entscheidung von Nojo, 2026-10-21).
- **Automatische Erkennung** (`learnweb/schedule.py`, `schedule.rs`, `syncui.ts`): Nach der Anmeldung läuft der Abgleich von selbst (Fortschritt auf dem
  Anmeldebild, später der Knopf mit den zwei Pfeilen in der Leiste; beim Start gleicht Kursbuch ab, wenn der Stand älter als 20 Stunden ist).
  Kurse: `kurse_ab: "auto"` nimmt das vorige und das laufende Semester. Farben: jeder Kurs bekommt seinen Farbton selbst (`colors.rs`).
  Kursart (Vorlesung, Seminar, Übung): aus dem Titel. **Wochentage** der Veranstaltungen: aus mindestens zwei wöchentlich liegenden
  Sitzungsterminen des Kurses; die **Uhrzeit** nur, wenn sie in einem LearnWeb-Text bei einem Wochentag steht („Mo 10–12“, c.t./s.t.;
  Sprechstunde, Abgabe, Klausur und Zoom zählen nicht). LearnWeb nennt Vorlesungszeiten selten: Funde mit Uhrzeit legt der Stundenplan
  selbst an (✦, Quelle in der Karte), Funde ohne Uhrzeit stehen als Chips über dem Plan; ein Klick bietet Doppelstunden (8–10, 10–12 …)
  oder eine eigene Zeit an, ✕ verwirft den Fund für immer (`schedule-dismissed.json`). Was man löscht oder ändert, kommt nicht wieder.
  Nicht enthalten: Import aus LSF/HISinOne (dafür gibt es den .ics-Import).
- **Kurs-Layer** (`courselayer.ts`): Ein Klick auf einen Kurs (Liste, Zeitstrahl, Stundenplan, Abgaben, Suche, Deep Link) öffnet die ganze Kursseite als
  Layer über dem Dashboard, **nicht Vollbild** (Rand ringsum, abgedunkelter Hintergrund; die Leiste mit den Knöpfen bleibt bedienbar). Er wächst aus dem
  angeklickten Element; Esc, das Kreuz oder ein Klick daneben schließen ihn, ein zweiter Kurs tauscht den Inhalt. Der Knopf „In eigenem Fenster“ öffnet den
  alten Fenster-Modus. Die Seitenspalte (Abgaben, Dozenten) hängt an der Breite des Layers, nicht des Fensters.
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
- **Anmeldung und Fokus** (`scene.ts`, `focus.ts`, `pomodoro.ts`, `focus.rs`): Ohne gespeicherte Zugangsdaten zeigt das Fenster nur den
  farbigen Verlauf mit einem Liquid-Glass-Anmeldefeld; nach der Anmeldung fährt die dunkle Fläche von unten hoch. Der Griff oben an der Fläche
  (oder der Timer-Knopf in der Leiste) fährt sie in den **Fokus-Modus** herunter: To-do-Listen (mehrere, Aufgabe → Timer starten), Pomodoro-Timer
  (25 / 5 min einstellbar, nach vier Runden die dreifache Pause; nichts startet von selbst) und **Lernstreak** (Tage in Folge mit einer
  abgeschlossenen Fokusphase, Raster der letzten 12 Wochen). Alles liegt in `focus.json` im App-Ordner.
- **Pomodoro-Widget** (`widget.ts`, `widget.rs`): Beim Start öffnet sich ein eigenes Fenster ohne Rahmen, durchsichtig, immer oben, überall verschiebbar
  (die Lage wird gemerkt). Es zeigt den Timer des Hauptfensters und steuert ihn (Pause, Weiter, Überspringen, Stopp); Stopp schließt es; der Knopf mit dem Auge in der Leiste (sichtbar bei laufendem Timer und im Fokus-Modus) und der kleine
  Knopf im Widget blenden es aus und wieder ein (der Timer läuft weiter, die Wahl wird gemerkt). Dazu die
  Karte `kursbuch:pomodoro` in der Notch (Wert, Balken, Knöpfe; `pomodoro.rs`). Schließt man das Hauptfenster, endet die App.
- **Hintergrund**: Der Knopf mit der Sonne in der Leiste wechselt zwischen dem bewegten Farbverlauf und einem weichen Beige (Anmeldebild, Fokus,
  Leiste und Widget; die dunkle Fläche bleibt dunkel). **Schrift**: Nunito Sans (variable, OFL, mit der App gebündelt).
- **Größen und Bewegung**: ab 960 px drei Spalten; darunter werden die Abgaben eine Schublade (Knopf in der Leiste); sehr breite und
  niedrige Fenster passen Abstände und Schrift an. Hover und Klick ändern nie die Größe (Inhalt rückt per `translate`, Schriftstärke bleibt gleich),
  Menüs, Karten und Meldungen blenden ein und aus, Listen steigen nacheinander auf; „Bewegung reduzieren“ des Systems wird beachtet. F11 = Vollbild.
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

**Zwei Betriebsarten** (`data.rs`, `Paths::choose`), automatisch gewählt: *Mitgeliefert* (Installer von GitHub): Kursbuch ruft die beigelegte
`learnweb-bridge.exe` auf (`LEARNWEB_HOME` = `%APPDATA%\de.nojo.kursbuch\bridge`, dort liegen `data/` und `sync_config.json`); niemand braucht Python
oder uv. *Entwickler*: gibt es `%USERPROFILE%\learnweb-mcp` (mit `pyproject.toml`) und `%USERPROFILE%\.local\bin\uv.exe`, ruft Kursbuch wie bisher
`uv run python -m learnweb.cli` dort auf; der Daten- und Notiz-Betrieb (Vault, geplanter Sync, MCP-Server) bleibt unberührt. Überschreibbar über
`settings.json` in `%APPDATA%\de.nojo.kursbuch` (`project`, `uv`; `"notch": false` schaltet die Notch-Karte ab). Der Kursordner (Vorgabe
`Dokumente\Kursbuch\LearnWeb`) lässt sich im Konto-Menü anzeigen, öffnen und ändern; Obsidian-Notizen gibt es nur, wenn über dem Ordner ein Obsidian-Tresor liegt.
Zum Ausprobieren gegen Kopien: Umgebungsvariablen `KURSBUCH_PROJECT` (Projektordner), `KURSBUCH_CONFIG` (App-Ordner) und `KURSBUCH_DOWNLOADS`
(Zielordner des .ics-Exports; ohne sie zeigt der Export die Datei im Explorer).

## Inhalte ohne Datei (Kursfenster)

Die Python-Seite holt beim Sync (und mit `uv run python -m learnweb.cli content [--force]`) zusätzlich **Ankündigungen** (Nachrichtenforen,
neue Themen), **Aufgaben** (Beschreibung, Abgabe- und Bewertungsstatus) und **Dozenten** (Teilnehmerliste nach Rolle, Profil mit E-Mail; nur alle
14 Tage; nie Studierende) nach `data/content.json` und in den Suchindex. Das Kursfenster zeigt die Ankündigungen oben im Seitenfluss und rechts die
**Abgaben** des Kurses (Frist, Status) sowie **Dozenten und Kontakt** mit der Quelle („LearnWeb: Teilnehmerliste und Profil, Stand …“) und weitere
Adressen aus Kurstexten mit Fundstelle. Verweise öffnen im Browser (nur http, https, mailto).

## Deep Link

`kursbuch://heute` (Zeitstrahl und Woche auf heute), `kursbuch://kurs/<id>` (Kursfenster öffnen),
`kursbuch://suche/<Begriff>` (Suche öffnen und ausführen). Ein Link darf nur **navigieren**; alles Verformte wird ignoriert. Ein zweiter Start
reicht ihn an die laufende App weiter. Die App meldet das Schema beim Start an (im Entwicklungsbetrieb: `target\debug`).

## Updates und Veröffentlichen (wie Arena und die Notch)

Kursbuch aktualisiert sich selbst: 20 s nach dem Start und dann alle 6 h fragt es
`https://github.com/NojoMcDybo/kursbuch/releases/latest/download/latest.json`. Gibt es eine neue Version, leuchtet ein Punkt am Konto-Kreis;
im Konto-Menü steht **Installieren** (lädt, prüft die Signatur mit dem öffentlichen Schlüssel aus `tauri.conf.json`, derselbe wie bei Arena und
Notch, und startet neu).

Veröffentlichen: Version in `package.json`, `package-lock.json`, `src-tauri/Cargo.toml` und `src-tauri/tauri.conf.json` erhöhen, committen, Tag
`v<version>` pushen. `.github/workflows/release.yml` baut zuerst die Python-Seite zu `learnweb-bridge.exe` (`tools/build-bridge.ps1` aus `bridge/`, mit
Selbsttest), dann den Installer, signiert (Secret `TAURI_SIGNING_PRIVATE_KEY`; der private Schlüssel liegt nur unter
`%USERPROFILE%\.tauri\nojo-updater.key`) und hängt Installer und `latest.json` an das Release. Einmalig: Repository `NojoMcDybo/kursbuch` anlegen
und das Secret setzen (`gh secret set TAURI_SIGNING_PRIVATE_KEY < %USERPROFILE%\.tauri\nojo-updater.key`).

Lokal bauen: erst die Brücke (`tools\build-bridge.ps1`, Ergebnis in `bridge-dist\`), dann
`npx tauri build --bundles nsis --config src-tauri/tauri.bridge.conf.json` (Installer unter `src-tauri\target\release\bundle\nsis`, bei fremdem
`CARGO_TARGET_DIR` dort). Ohne `--config` entsteht ein Installer ohne Brücke; der taugt nur, wo `learnweb-mcp` und `uv` vorhanden sind (Entwickler-Betrieb).
Installer per Explorer starten (die Claude-App läuft virtualisiert); Installation außerhalb von AppData: `Kursbuch_…-setup.exe /S /D=D:\Dev\_apps\Kursbuch`.

Die Brücke in `bridge/` ist ein bereinigter Schnappschuss des Entwicklungsordners der Python-Seite: `tools\sync-bridge.ps1 -Source <Ordner> [-Kennung <Uni-Kennung>]`
kopiert, ersetzt die Kennung im Test, prüft, dass keine persönlichen Angaben darin stehen, und lässt die Tests laufen. `bridge/` nicht von Hand ändern.

## Lizenz

MIT (siehe `LICENSE`). Kursbuch ist kein Angebot der Universität Münster und hat keine offizielle Schnittstelle zu LearnWeb.

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
- Umbau 3: Pomodoro-Widget, Beige-Hintergrund, Nunito Sans, Selbst-Update (v0.2.0), Inhalte ohne Datei im Kursfenster.
- Umbau 4 (v0.3.0): Stundenplan und Wochenkalender in einem, automatische Erkennung von Kursen, Farben, Wochentagen und Zeiten, Abgleich aus der App mit Fortschritt, Widget ausblendbar, ruhigere Abstände und Animationen.
- v0.3.1: Sicherheitsprüfung (`docs/sicherheitspruefung-0.3.0.md`): Content-Security-Policy, „Passwort speichern“ (Haken im Anmeldeformular), Gerätenamen, `mailto:`.
- v0.3.3: Spalten als Karten (klare Trennung, gleiche Kopf-, Unter- und Inhaltszeile), Vorschläge aus Kurstexten (Phase 5), Abgaben mit Leerzustand.
- v0.3.2: Kurse per Ziehen dem Stundenplan zuordnen, Kurs-Layer im gleichen Fenster, Zeitstrahl als Glasfläche, Leistenmodule gleich groß, Spalten beginnen auf einer Höhe.
- Zum Weitergeben (siehe `docs/weitergeben.md`): Brücke als `learnweb-bridge.exe` im Installer, Kursordner im Konto-Menü, Obsidian optional.
