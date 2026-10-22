# Aufgaben: Kursbuch zum Weitergeben (siehe plan.md)

## Phase A – Brücke mitliefern
- [x] **A1 Python (learnweb-mcp):** `LEARNWEB_HOME` bestimmt `ROOT` für `data/` und `sync_config.json`; Vorgabe `ziel` = `Dokumente\Kursbuch\LearnWeb`; `cli selftest`.
  - Kriterien: ohne `LEARNWEB_HOME` unverändert; mit Variable liegen alle Dateien dort; `selftest` meldet JSON `{ok, checks}`; Nojos `sync_config.json` bleibt gültig.
  - Geprüft: `uv run pytest` 195 grün (u. a. Pfad `Jörg Müller\brücke`, neutrale Vorgabe); Commit 563d9a1.
- [x] **A2 PyInstaller:** `tools/build-bridge.ps1` (kein `.spec`, alle Optionen im Skript; onedir, keyring/certifi/docx/pptx-Daten, ohne `mcp`); Rauchtest der `.exe`.
  - Geprüft: `selftest` ok (Tresor, 121 Zertifikate, FTS5, Leser, Datenordner), `status`, `config get`, `events`, `suggest` laufen; 49 MB aus `bridge/`. `selftest --net` nicht belegt (LearnWeb war von hier nicht erreichbar).
- [x] **A3 Rust:** `Paths.bridge`; Betriebsart (Entwickler/mitgeliefert); `py.rs` ruft die `.exe` mit `LEARNWEB_HOME`.
  - Geprüft: `cargo test` 74 grün (Auswahl, direkter Aufruf, Passwort weiter nur per stdin).
- [ ] **A4 Tauri:** `bundle.resources` bringt `bridge/` in den Installer (`tauri.bridge.conf.json`, nur Release); Auflösung über `resource_dir`, `KURSBUCH_BRIDGE` für Tests.
  - Kriterien: gebauter Installer enthält die Brücke; installierte App findet sie. (Debug-Build ohne Bündel belegt: Ressource landet unter `target\debug\bridge`; Installer: Build läuft.)

### Checkpoint A
- [x] Python- und Rust-Tests grün · gefrorene Brücke besteht den Selbsttest · Nojos Entwickler-Modus unverändert (Test-Instanz ohne `uv`-Übersteuerung wählte „entwickler“ mit `~/learnweb-mcp`)

## Phase B – Erststart und Einstellungen
- [x] **B1 Rust:** `settings_get` (Ordner, Betriebsart, Datenordner), `settings_set_ziel`, `tauri-plugin-dialog` (Ordnerwahl), Capability nur Hauptfenster; `npm audit` 0.
- [x] **B2 Oberfläche:** Konto-Menü: Kursordner (anzeigen, öffnen, ändern); Fortschrittskarte nennt den Ordner.
- [x] **B3 Obsidian nur mit Tresor:** `course_view.note` nur mit `.obsidian` im Elternordner von `ziel`; Knopf ausgegraut mit Hinweis.

### Checkpoint B
- [x] Test-Instanz im Modus „mitgeliefert“ (Stub-Brücke, `uv` per `settings.json` auf eine fehlende Datei gelegt): `settings_get` → mitgeliefert, Daten in `…\bridge\data`; Anmeldebild, Anmeldung (Passwort per stdin), Fortschrittskarte mit Ordner, Konto-Menü (Öffnen/Ändern), `settings_set_ziel` (gültig/ungültig), Notiz-Knopf ohne Tresor ausgegraut.
  - Nicht geprüft: der Ordnerdialog selbst (native Fenster), mit der echten Brücke und echtem LearnWeb.

## Phase C – Weitergeben
- [x] **C1 Schnappschuss:** `tools/sync-bridge.ps1` kopiert bereinigt nach `bridge/` (ohne `server.py`, Skripte, Prompt-Dokument; `mcp` aus pyproject und uv.lock; Kennung im Test → `abc123`); Prüfung auf Windows-Benutzer, Profilpfad und die angegebene Kennung; Tests im Schnappschuss 195 grün.
- [x] **C2 Workflow:** `release.yml` baut die Brücke (uv, PyInstaller), prüft `selftest` und übergibt `tauri.bridge.conf.json` an `tauri build`. (Läuft erst beim Tag auf GitHub.)
- [x] **C3 Anleitung:** `docs/weitergeben.md`, README-Abschnitte. Lizenz: MIT (Nojo, 2026-10-22).

### Checkpoint C
- [ ] Tag auf einem Testlauf des Workflows (oder lokal nachgestellt) liefert einen Installer mit Brücke

## Phase D – Abnahme
- [x] **D1 „Frischer Rechner“:** Test-Instanz ohne uv, leere Konfiguration, mitgelieferte Brücke (Stub und echte `.exe` im Heimordner mit Leerzeichen/Umlaut). Kein Zugriff auf Nojos Daten (Daten unter `…\bridge`).
- [ ] **D2 Release und Gegenprobe:** Version 0.4.0, Installation bei Nojo (nach Freigabe), Entwickler-Modus erkennt `learnweb-mcp`, geplanter Sync und MCP-Server unberührt; Tag (nach Freigabe).
