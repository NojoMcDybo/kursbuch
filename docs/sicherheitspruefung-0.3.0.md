# Sicherheitsprüfung Kursbuch 0.3.0 (Differential Review)

Methode: Skill `differential-review` (Trail of Bits), Phasen 0–6 von Hand (der Skill `audit-context-building` ist nicht installiert).
Stand: 2026-10-14. Geprüft: `kursbuch` `12bb370..34662cb` (v0.2.0 → v0.3.0) und die Python-Brücke `learnweb-mcp` (`schedule.py`,
`sync.py`, `cli.py`, `credentials.py`, `client.py`), dazu die Angriffsfläche als Ganzes (Tauri-Konfiguration, Befehle, Dateizugriffe,
Prozessaufrufe, Deep Link) und die neue Funktion „Passwort speichern“.

## Zusammenfassung

| Schwere | Anzahl | Stand |
|---|---|---|
| 🔴 Kritisch | 0 | – |
| 🟠 Hoch | 0 | – |
| 🟡 Mittel | 1 | behoben (Content-Security-Policy war aus) |
| 🟢 Niedrig | 3 | alle behoben |
| ℹ️ Hinweise | 4 | dokumentiert, keine Änderung nötig |

**Gesamtrisiko: niedrig.** **Empfehlung: freigeben** (nach den hier eingearbeiteten Korrekturen).
Die App spricht nie selbst mit LearnWeb, kennt keine Zugangsdaten außer in der Anmeldung, öffnet nur Dateien unter dem Zielordner und
nur Adressen in LearnWeb bzw. `https://`/`http://`/`mailto:`, und die Oberfläche setzt nirgends fremden Text als HTML ein.

Kennzahlen: 25 Dateien / +1131 −340 Zeilen im Bereich v0.2.0→v0.3.0; Hochrisiko-Dateien (Anmeldung, Prozessstart, Dateipfade,
Deep Link, Updater) vollständig gelesen; entfernter Code mit Sicherheitsbezug: keiner (die Diffs enthalten keine entfernte Prüfung).

## Was sich geändert hat (Risiko je Bereich)

| Bereich | Änderung | Risiko |
|---|---|---|
| `sync.rs`, `py.rs::stream` | Sync aus der App (Prozess `uv run python -m learnweb.cli sync --json`, Zeilen als Ereignis) | mittel |
| `schedule.rs` | liest `data/schedule.json` (aus LearnWeb-Texten abgeleitet), `schedule_dismiss(key)` schreibt `schedule-dismissed.json` | mittel |
| `timetable.rs/.ts` | neue Felder `auto`, `note`; Funde legen Plan-Einträge an | mittel |
| `schedule.py`, `sync.py` | Erkennung aus LearnWeb-Text, Kursauswahl „auto“ | mittel (verarbeitet fremden Text) |
| Oberfläche (Wochenansicht, Fortschritt, Widget-Knopf) | nur Darstellung | niedrig |
| **neu in dieser Prüfung:** „Passwort speichern“ | Passwort kann nur für die Sitzung gelten | **hoch** (Anmeldung) |

## Befunde

### 🟡 MITTEL – Keine Content-Security-Policy (`tauri.conf.json`, `"csp": null`) – behoben
Eine Schwachstelle gab es nicht, aber keine zweite Verteidigungslinie: Jedes eingeschleuste Skript hätte über die Oberfläche alle Tauri-Befehle
(Anmelden, Datei öffnen, Stundenplan schreiben …) aufrufen können. Die Oberfläche zeigt viel fremden Text aus LearnWeb (Ankündigungen,
Namen, Aufgaben).
- Prüfung des Ist-Zustands: kein `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `eval`, `srcdoc` in `src/` (Suche über alle
  Dateien; Texte gehen über `textContent`). Es gibt also heute keine Einschleusstelle.
- Korrektur: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:;
  connect-src 'self' ipc: http://ipc.localhost; object-src 'none'; base-uri 'none'; form-action 'none'`.
- Verifiziert in einem Build, der die gebündelte Oberfläche ausliefert (mit `tauri dev` greift die CSP nicht): Seite, Schrift, Hauptfenster,
  Suchfenster, Konto-Menü, Fokus-Ansicht, Wochenwechsel und Kursfenster laufen ohne Verstoß; eine externe Anfrage (`connect-src`) und ein
  eingeschleustes Inline-Skript (`script-src-elem`) werden blockiert; die Befehlsschnittstelle (`ipc:`) funktioniert.
- Rest: `'unsafe-inline'` bei Stilen ist nötig (Positionen und Farben werden als `style` gesetzt); Skripte sind damit nicht erlaubt.

### 🟢 NIEDRIG – Windows-Gerätenamen als Dateinamen (`learnweb/client.py::safe_filename`) – behoben
Ein Dateiname aus LearnWeb wie `CON`, `NUL.pdf`, `COM1.docx` ist unter Windows ein Gerät: Schreiben ginge an die Konsole bzw. ins Nichts (Datenverlust
beim Sync, im Extremfall ein hängender Schreibvorgang auf `COM1`). Bisher entfernte `safe_filename` nur Sonderzeichen. Angreifer: wer Dateien in
einem Kurs hochladen darf. Korrektur: Namen, die ein Gerät bezeichnen, bekommen ein `_` vorangestellt; Test `test_windows_device_names_never_become_file_names`.

### 🟢 NIEDRIG – `mailto:` mit `?attach=` (`content.rs::external_ok`) – behoben
Der Verweis „E-Mail an …“ aus Kursseiten ließ jede `mailto:`-Adresse durch. Manche Mailprogramme hängen über `?attach=` eine lokale Datei oder
Netzfreigabe an. Es braucht einen Klick des Nutzers auf einen Verweis, den ein Dozent oder Teilnehmer in LearnWeb setzen kann.
Korrektur: `mailto:` mit „attach“ wird nicht geöffnet (Test ergänzt).

### 🟢 NIEDRIG – `powershell.exe` ohne Pfad (`share.rs`) – behoben
Das Kopieren einer Datei in die Zwischenablage startete `powershell.exe` über den Suchpfad (Programmordner, dann PATH). Jetzt
`%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`, mit dem alten Verhalten als Rückfall.

### ℹ️ Hinweise (keine Änderung)
1. **Alle Fenster dürfen alle App-Befehle aufrufen** (`capabilities/default.json` begrenzt nur Fenster-Rechte; eigene Befehle sind nicht eingeschränkt).
   Die Fenster `main`, `kurs-*`, `pomodoro` laden ausschließlich App-Seiten, nie Fremdinhalt. Mit der neuen CSP ist das vertretbar.
2. **`settings.json` im App-Ordner darf `project` und `uv` überschreiben** (Test-Hook). Wer dort schreiben kann, kann damit ein Programm starten lassen –
   er hat dann schon Benutzerrechte (gleiche Vertrauensstufe).
3. **Kleiner lokaler HTTP-Verkehr zur Notch** (`127.0.0.1:47800`): nur Karten senden und Pomodoro-Aktionen abholen; die Aktionen werden gegen eine
   feste Liste geprüft (`pomodoro.rs::actions`). Ein anderer lokaler Prozess könnte den Timer fernbedienen – kein Zugriff auf Daten.
4. **Abhängigkeiten:** `npm audit` meldet 0 Schwachstellen. `cargo audit` und `pip-audit` sind nicht installiert und wurden **nicht** ausgeführt.

## Neue Funktion „Passwort speichern“ (Phase 5, Angreifermodell)

Verhalten: Haken gesetzt (Vorgabe) = wie bisher (`learnweb.cli login` prüft und legt im Windows-Tresor ab). Ohne Haken: `login <kennung> --no-save`
prüft nur; die App merkt sich Kennung und Passwort im Speicher (`py.rs::SESSION`) und reicht es dem Sync, dem Sofort-Download und dem Inhaltsabruf
als erste Zeile auf stdin (`--password-stdin`) durch; die Kennung geht zusätzlich als `LEARNWEB_USER` in die Umgebung (kein Geheimnis). Abmelden verwirft es.

| Frage | Ergebnis |
|---|---|
| Landet das Passwort auf der Platte? | Nein. Kein Tresor-Eintrag (`credentials.keyring.store == {}` im Test), keine Datei, kein Log. |
| In Argumenten oder Umgebung? | Nein: nur stdin; Test `session_password_goes_in_by_stdin_never_by_argument_or_environment` prüft beides. |
| Überschreibt/löscht es bestehende Zugangsdaten? | Nein (Test `test_no_save_login_leaves_an_existing_stored_login_alone`): geplanter Sync und MCP-Server laufen weiter. |
| Wird ein falsches Passwort gemerkt? | Nein: die Sitzung wird erst nach erfolgreicher Prüfung gesetzt. |
| Welche Befehle bekommen es? | Nur `sync`, `fetch`, `content` (`needs_login`); `status`, `login`, `logout`, `schedule` nicht. |
| Eingabeprüfung | unverändert: Kennung `valid_user` (kein führendes `-`, keine Leerzeichen), Passwort ohne Zeilenumbruch; `--no-save` und `--password-stdin` sind feste Texte. |
| Verhalten ohne Haken nach Neustart | angemeldet ist man nicht mehr (Anmeldebild); Tresor unberührt. |
| Praxis-Test (Stub-Python-Seite, kein echtes LearnWeb) | `login … --no-save`, danach `sync` mit `--password-stdin`, korrektem Passwort auf stdin und Kennung in der Umgebung; kein `state.json`; Abmelden → Anmeldebild. Mit Haken: gespeichert wie bisher. |

Restrisiko: Das Passwort liegt als normaler Text im Speicher des App-Prozesses, bis man sich abmeldet oder beendet, und wird nicht überschrieben
(`shortcut: kein zeroize; bei Bedarf Zeroizing<String>`). Wer den Speicher des Prozesses lesen kann, hat bereits Benutzerrechte. Das Eingabefeld
wird sofort nach dem Lesen geleert (unverändert).

## Testabdeckung

Neu: Rust +2 Fälle in `py.rs`, 1 in `schedule.rs` (Kürzung), 1 in `content.rs` (`mailto:`); Python +4 (`--no-save`, Tresor unberührt,
`--password-stdin`, Gerätenamen). Stand: 65 Rust-, 178 Python-Tests, `tsc` ohne Fehler.
Lücken: keine automatischen Oberflächentests (die Abläufe wurden mit einer Zweit-Instanz gegen eine Stub-Python-Seite von Hand geprüft);
die CSP wird nur in einem Build mit gebündelter Oberfläche wirksam, nicht unter `tauri dev`.

## Grenzen dieser Prüfung

Nicht geprüft: echtes LearnWeb (Stub, keine echten Zugangsdaten), Windows-Tresor selbst (`keyring`), Updater-Signatur im Betrieb,
Abhängigkeiten von Rust und Python auf bekannte Schwachstellen (Werkzeuge fehlen), Verhalten unter anderen Windows-Versionen.
Vertrauensgrad: hoch für die genannten Dateien, mittel für das Gesamtsystem.
