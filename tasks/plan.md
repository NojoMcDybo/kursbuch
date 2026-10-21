# Plan: Kursbuch zum Weitergeben („sauberer Weg“)

Stand 2026-10-21, Auftrag von Nojo: „Mach den sauberen Weg“. Ziel: Ein Freund (Uni Münster) lädt **einen** Installer, installiert, meldet sich mit
der eigenen Kennung an, und alles läuft – ohne `uv`, ohne `learnweb-mcp`-Ordner, ohne Kommandozeile, ohne Obsidian.

## Ist-Zustand (Befunde)

* Kursbuch ruft für alles, was LearnWeb betrifft, `uv run python -m learnweb.cli …` in `%USERPROFILE%\learnweb-mcp` auf (`py.rs`, `data.rs`).
  Das Projekt liegt nur lokal (kein Remote), `uv` muss unter `%USERPROFILE%\.local\bin` liegen.
* Die Brücke legt `data/` und `sync_config.json` neben ihre Quellen (`ROOT = parents[1]`); Vorgabe-Ziel war der Obsidian-Tresor des Entwicklers.
* Persönliches im Python-Projekt: Uni-Kennung als Vorgabe in `get-token.ps1`, `setup_login.py`, `tests/test_client.py` (und im Verlauf), dazu
  `docs/desktop-app-prompt.md`, `tools/run_sync.ps1`. Das Kursbuch-Repo ist sauber (öffentlich, ohne Lizenz).
* Obsidian-Knöpfe gehen davon aus, dass `ziel` in einem Obsidian-Tresor liegt.
* Nojos eigene Einrichtung (geplanter Sync 07:15, MCP-Server, Obsidian-Notizen) **muss unverändert weiterlaufen** (harte Regel 5 im Auftrag).

## Entscheidungen

1. **Brücke als mitgelieferte `.exe`** (PyInstaller, `--onedir`, Tauri-Ressource), Aufruf mit denselben Argumenten wie `python -m learnweb.cli`.
   Grund: kein Internet beim ersten Start, kein `uv`/Python beim Freund, schnell (onedir). Risiko: Virenscanner melden PyInstaller manchmal
   fälschlich; ohne Signatur zeigt Windows SmartScreen eine Warnung (in der Anleitung beschrieben).
2. **Zwei Betriebsarten, automatisch gewählt:** (a) *Entwickler* wie bisher, wenn `%USERPROFILE%\learnweb-mcp\pyproject.toml` und `uv` da sind oder
   `settings.json` es verlangt (Nojos Fall: nichts ändert sich); (b) *mitgeliefert* sonst. Daten der mitgelieferten Brücke:
   `%APPDATA%\de.nojo.kursbuch\bridge\` (`data\`, `sync_config.json`); Umgebungsvariable `LEARNWEB_HOME` sagt der Brücke, wo.
3. **Vorgabe-Ordner** für Kursdateien: `Dokumente\Kursbuch\LearnWeb` statt Nojos Vault. Nojos `sync_config.json` nennt `ziel` ausdrücklich, ändert sich nicht.
4. **Einstellungen im Konto-Menü:** Kursordner anzeigen, öffnen, ändern (Ordnerwahl über `tauri-plugin-dialog`, nur Hauptfenster); Änderung über
   `cli config set ziel` (Prüfung steht schon in Python). Weitere Einstellungen bleiben CLI-only.
5. **Obsidian optional:** „Notiz in Obsidian“ nur, wenn `ziel/..` ein Tresor ist (`.obsidian` vorhanden).
6. **Quelle der Brücke im Kursbuch-Repo:** `bridge/` ist ein **bereinigter Schnappschuss** von `learnweb-mcp` (ohne Kennung, Prompt-Dokument, Aufgaben-Skripte,
   MCP-Server), erzeugt von `tools/sync-bridge.ps1`. Vorteil: ein öffentliches Repo, CI braucht kein zweites Repo und kein Token. `learnweb-mcp` bleibt die Arbeitskopie.
7. **Selbsttest** `learnweb.cli selftest` (ohne Netz): prüft Tresor-Anbindung, Zertifikate, FTS5, PDF/DOCX/PPTX-Leser – findet Paketierungsfehler vor dem Freund.
8. Keine Signatur (Kosten, Identitätsprüfung): Anleitung erklärt die SmartScreen-Meldung.

## Aufgaben (Reihenfolge nach Abhängigkeiten, Verifikation je Aufgabe in `todo.md`)

**Phase A – Brücke mitliefern:** A1 Python: `LEARNWEB_HOME`, neuer Vorgabe-Ordner, `selftest` · A2 PyInstaller-Skript und Rauchtest der gefrorenen `.exe` ·
A3 Rust: Betriebsart, `py.rs` ruft die `.exe` · A4 Tauri-Ressource und Installer.
**Phase B – Erststart und Einstellungen:** B1 Einstellungs-Befehle und Ordnerwahl · B2 Oberfläche · B3 Obsidian nur mit Tresor.
**Phase C – Weitergeben:** C1 `bridge/`-Schnappschuss und Bereinigung · C2 Release-Workflow baut die Brücke · C3 Anleitung `docs/weitergeben.md`, README, Lizenz (Nojo wählt).
**Phase D – Abnahme:** D1 „frischer Rechner“ nachgestellt (leeres Profil, kein `uv`) · D2 Release, Installation bei Nojo, Gegenprobe seiner Einrichtung.

## Risiken

| Risiko | Wirkung | Gegenmaßnahme |
|---|---|---|
| Tresor (`keyring`) im gefrorenen Programm nicht gefunden | Anmeldung scheitert | `--collect-all keyring`, Selbsttest prüft Backend |
| TLS-Zertifikate fehlen (`certifi`) | LearnWeb nicht erreichbar | `--collect-data certifi`, Selbsttest prüft die Datei |
| Antivirus/SmartScreen | Freund bricht ab | onedir statt onefile, Anleitung, Hash im Release nennen |
| Nojos Einrichtung wird durch neue Betriebsart verändert | Datenverlust-Gefühl, harte Regel 5 | Erkennung: `learnweb-mcp` vorhanden → Entwickler-Modus; Test dafür |
| Pfade mit Leerzeichen/Umlauten beim Freund (`C:\Users\Jörg Müller`) | Aufruf scheitert | Tests mit solchen Pfaden, Aufruf ohne Shell |
| Persönliches im Schnappschuss | Kennung öffentlich | Skript ersetzt/entfernt, Suche nach der Kennung als Test |

## Offene Fragen an Nojo

* **Lizenz** für das öffentliche Kursbuch-Repo (Vorschlag MIT)?
* Der Schnappschuss `bridge/` enthält den Python-Code der Brücke öffentlich (ohne Verlauf, ohne Kennung): einverstanden?
