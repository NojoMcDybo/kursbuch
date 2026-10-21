# Aufgaben: Kursbuch zum Weitergeben (siehe plan.md)

## Phase A – Brücke mitliefern
- [ ] **A1 Python (learnweb-mcp):** `LEARNWEB_HOME` bestimmt `ROOT` für `data/` und `sync_config.json`; Vorgabe `ziel` = `Dokumente\Kursbuch\LearnWeb`; `cli selftest`.
  - Kriterien: ohne `LEARNWEB_HOME` unverändert; mit Variable liegen alle Dateien dort; `selftest` meldet JSON `{ok, checks}`; Nojos `sync_config.json` bleibt gültig.
  - Prüfen: `uv run pytest` grün (neue Tests), Aufruf mit Pfad mit Leerzeichen und Umlaut.
- [ ] **A2 PyInstaller:** `tools/build-bridge.ps1`, `learnweb-bridge.spec` (onedir, collect keyring/certifi/lxml-Daten, ohne `mcp`); Rauchtest der `.exe`.
  - Kriterien: `learnweb-bridge.exe selftest` ok; `status`, `config get`, `events`, `suggest`, `index`, `verzeichnis` laufen auf Testdaten; Größe genannt.
- [ ] **A3 Rust:** `Paths.bridge`; Betriebsart (Entwickler/mitgeliefert); `py.rs` ruft die `.exe` mit `LEARNWEB_HOME`.
  - Kriterien: Test: vorhandenes `learnweb-mcp` → Entwickler; sonst mitgeliefert; `settings.json` übersteuert; Passwort weiter nur per stdin.
  - Prüfen: `cargo test`.
- [ ] **A4 Tauri:** `bundle.resources` bringt `bridge/` in den Installer; Auflösung über `resource_dir`, `KURSBUCH_BRIDGE` für Tests.
  - Kriterien: gebauter Installer enthält die Brücke; installierte App findet sie.

### Checkpoint A
- [ ] Python- und Rust-Tests grün · gefrorene Brücke besteht den Selbsttest · Nojos Entwickler-Modus unverändert (Test in der Test-Instanz)

## Phase B – Erststart und Einstellungen
- [ ] **B1 Rust:** `settings_get` (Ordner, Betriebsart, Datenordner), `settings_set_ziel`, `tauri-plugin-dialog` (Ordnerwahl), Capability nur Hauptfenster; `npm audit`.
- [ ] **B2 Oberfläche:** Konto-Menü: Kursordner (anzeigen, öffnen, ändern), Hinweis zur Änderung; Fortschrittskarte nennt den Ordner.
- [ ] **B3 Obsidian nur mit Tresor:** `course_view.note` nur mit `.obsidian` im Elternordner von `ziel`.

### Checkpoint B
- [ ] Test-Instanz im Modus „mitgeliefert“ (leeres Profil, Stub-Brücke oder gefrorene Brücke mit Testdaten): Anmeldeablauf, Einstellungen, Ordnerwechsel

## Phase C – Weitergeben
- [ ] **C1 Schnappschuss:** `tools/sync-bridge.ps1` kopiert bereinigt nach `bridge/` (Kennung → `abc123`, ohne Prompt-Dokument, Skripte, MCP-Server); Test sucht die Kennung.
- [ ] **C2 Workflow:** `release.yml` baut die Brücke (Python 3.13, uv, PyInstaller) vor `tauri-action`.
- [ ] **C3 Anleitung:** `docs/weitergeben.md` (Download, SmartScreen, Anmeldung, Datenschutz, Grenzen), README-Abschnitt; Lizenz nach Nojos Wahl.

### Checkpoint C
- [ ] Tag auf einem Testlauf des Workflows (oder lokal nachgestellt) liefert einen Installer mit Brücke

## Phase D – Abnahme
- [ ] **D1 „Frischer Rechner“:** leeres `USERPROFILE`, `PATH` ohne `uv`, mitgelieferte Brücke: App startet, Anmeldebild, Brücke antwortet (Selbsttest), Ordner, kein Zugriff auf Nojos Daten.
- [ ] **D2 Release und Gegenprobe:** neue Version, Installation bei Nojo (nach Freigabe), Entwickler-Modus erkennt `learnweb-mcp`, geplanter Sync und MCP-Server unberührt.
