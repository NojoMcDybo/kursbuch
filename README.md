# Kursbuch

LearnWeb (Uni Münster) im Nojo-Ökosystem: Kurse, Fristen und Volltextsuche auf den **lokalen** Daten des Syncs. Tauri v2 +
Rust + Vanilla-TS, Design aus `D:\Dev\nojo-design` (Kopie unter `src/nojo/`, aktualisieren mit
`powershell -File D:\Dev\nojo-design\tools\sync.ps1 -Only kursbuch`).

Der Auftrag mit allen Entscheidungen: `C:\Users\nojod\learnweb-mcp\docs\desktop-app-prompt.md`.

## Aufbau

```
LearnWeb ──(Python, learnweb-mcp)──► Vault + data/sync_state.json, deadlines.json, index.db
Kursbuch ──liest──► sync_state.json, sync_config.json     (App kennt keine Passwörter, spricht nie mit LearnWeb)
         ──öffnet──► PDF in Folio, Office/Bilder/Audio im Standardprogramm, Links im Browser, Notiz in Obsidian
```

- `src-tauri/src/model.rs` Datenvertrag (State, Konfiguration), Kursnamen in Titel/Semester/Dozent zerlegen
- `src-tauri/src/data.rs` State lesen (zwischengespeichert), Kursraster und Kursansicht
- `src-tauri/src/open.rs` Öffnen: die Oberfläche nennt nur IDs, Pfade kommen aus dem State und müssen unter `ziel` liegen.
  PDFs starten `%LOCALAPPDATA%\Folio\folio.exe` direkt (Windows hat Edge als PDF-Standard). Nur bekannte Dokumenttypen
  werden geöffnet, alles andere (z. B. `.exe`) nur im Explorer gezeigt. Adressen nur innerhalb von LearnWeb.
- `src-tauri/src/links.rs` Deep Link
- `src/` Oberfläche: `main.ts` (Reiter, Fenster), `kurse.ts` (Raster, Kursansicht), `api.ts` (typisierte Rust-Aufrufe)

Python-Projekt und `uv.exe` liegen standardmäßig unter `%USERPROFILE%\learnweb-mcp` und `%USERPROFILE%\.local\bin\uv.exe`
(überschreibbar über `settings.json` im App-Ordner `%APPDATA%\de.nojo.kursbuch`).

## Deep Link

`kursbuch://heute`, `kursbuch://kurs/<id>`, `kursbuch://suche/<Begriff>`. Ein Link darf nur **navigieren**: Kurs-IDs
(nur Ziffern, der State muss sie kennen), Suchbegriffe höchstens 100 Zeichen ohne Steuerzeichen; alles andere wird
ignoriert. Ein zweiter Start reicht den Link an die laufende App weiter. Die App meldet das Schema beim Start für den
Benutzer an (zeigt im Entwicklungsbetrieb auf `target\debug\kursbuch.exe`).

## Entwickeln

```powershell
npm install        # .npmrc schaltet devDependencies ein (NODE_ENV=production wird von der Claude-App vererbt)
npm run tauri dev
cargo test --manifest-path src-tauri/Cargo.toml
```

## Stand

- Phase 2: Gerüst, Kurse (Raster nach Semester, Kursansicht), Öffnen, Deep Link. Heute und Suche sind noch Hüllen.
- Phase 3: Heute (Fristen, Neu) und Volltextsuche, Notch-Karte `kursbuch:frist`.
- Phase 4: Sync aus der App, Einstellungen. Phase 5: Feinschliff, Installer.
