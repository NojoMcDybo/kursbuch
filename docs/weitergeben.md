# Kursbuch installieren und weitergeben

Kursbuch zeigt deine LearnWeb-Kurse der Uni Münster in einer Windows-Oberfläche: Kursinhalte, Stundenplan, Fristen und Suche, dazu die Dateien aus deinen Kursen in einem Ordner auf deinem Rechner.
Es braucht **nur den Installer**: kein Python, kein Obsidian, keine Kommandozeile.

## Was du brauchst

- Windows 10 oder 11 (64 Bit)
- Einen Uni-Zugang für LearnWeb (Uni Münster). Für andere Hochschulen funktioniert Kursbuch nicht.

## Installieren

1. Auf der Seite [Releases](https://github.com/NojoMcDybo/kursbuch/releases/latest) die Datei `Kursbuch_…_x64-setup.exe` laden. Die Prüfsumme (SHA-256) steht im Text des Releases; wer will, vergleicht sie mit `Get-FileHash <Datei>` in der PowerShell.
2. Doppelklick auf den Installer.
3. **Windows warnt** („Der Computer wurde durch Windows geschützt“, SmartScreen), weil der Installer nicht mit einem bezahlten Zertifikat signiert ist. Das Programm ist damit nicht gefährlicher als vorher; Windows kennt es nur noch nicht. Auf **Weitere Informationen** und dann **Trotzdem ausführen** klicken.
4. Fertig. Kursbuch startet und fragt nach der Anmeldung.

Manche Virenscanner schlagen bei Programmen, die mit PyInstaller gebaut sind (so wie die beigelegte `learnweb-bridge.exe`), fälschlich Alarm. Dann das Programm als Ausnahme zulassen oder den Fund beim Hersteller des Scanners als Fehlalarm melden.

## Erste Anmeldung

- Uni-Kennung (die „abc123“) und Passwort eintragen, **Anmelden**. Kursbuch prüft die Angaben bei LearnWeb und lädt danach deine Kurse. Der erste Abgleich dauert einige Minuten.
- **Passwort speichern** (voreingestellt) legt das Passwort im **Windows-Tresor** (Anmeldeinformationsverwaltung) ab, geschützt durch dein Windows-Konto, nicht in einer Datei. Ohne Haken gilt das Passwort nur, bis du dich abmeldest oder Kursbuch schließt.
- Abmelden löscht das gespeicherte Passwort wieder (Konto-Symbol oben links → **Abmelden**).

## Wo liegen die Dateien?

Standardmäßig in `Dokumente\Kursbuch\LearnWeb` (ein Ordner je Kurs). Im Konto-Menü (Symbol oben links) steht unter **Kursdateien** der Ordner; **Öffnen** zeigt ihn im Explorer, **Ändern …** wählt einen anderen. Beim nächsten Abgleich lädt Kursbuch dorthin; schon geladene Dateien bleiben am alten Ort und können dort gelöscht oder verschoben werden.

Wer Obsidian nutzt, legt den Ordner in einen Obsidian-Tresor (der Ordner `LearnWeb` direkt in einem Ordner mit `.obsidian`). Dann gibt es pro Kurs zusätzlich den Knopf für die Notiz. Ohne Obsidian ist dieser Knopf ausgegraut, sonst fehlt nichts.

Stand, Suchindex und Einstellungen der App liegen getrennt davon in `%APPDATA%\de.nojo.kursbuch` (in die Adressleiste des Explorers eintippen).

## Updates

Kursbuch sucht beim Start und alle sechs Stunden nach einer neuen Version. Am Konto-Symbol erscheint dann ein Punkt, im Konto-Menü steht **Installieren** (lädt, prüft die Signatur, startet neu). Auch von Hand: Konto-Menü → **Suchen**.

## Datenschutz

- Kursbuch spricht nur mit **LearnWeb der Uni Münster** (genau wie dein Browser) und mit **GitHub**, um nach Updates zu suchen. Sonst nichts: keine Statistik, kein Konto beim Entwickler, keine Weitergabe.
- Das Passwort verlässt deinen Rechner nur Richtung LearnWeb. Die App behält es nicht; sie reicht es einmal an die Brücke weiter, die es im Windows-Tresor ablegt (oder, ohne Haken, bis zum Beenden im Speicher hält).
- Kursdaten (Kursnamen, Termine, Texte, Dateien) liegen nur auf deinem Rechner. „Für KI kopieren“ legt Text in die Zwischenablage; was du damit einfügst, entscheidest du.
- Der Quelltext ist offen: <https://github.com/NojoMcDybo/kursbuch>. Die Sicherheitsprüfung steht in `docs/sicherheitspruefung-0.3.0.md`.

## Grenzen

- Nur lesend: Kursbuch ändert nichts in LearnWeb.
- Nur Uni Münster, nur Windows.
- LearnWeb hat für Kursbuch keine offizielle Schnittstelle. Kursbuch nutzt dieselben Seiten wie dein Browser; ändert die Uni etwas daran, kann der Abgleich ausfallen, bis eine neue Version da ist.
- Ein privates Hilfsmittel ohne Gewähr und ohne Support-Zusage. Nutze es für deine eigenen Kurse.

## Deinstallieren

Vorher im Konto-Menü **Abmelden** (löscht das Passwort aus dem Windows-Tresor), dann Windows-Einstellungen → Apps → Kursbuch → Deinstallieren. Den Kursordner und `%APPDATA%\de.nojo.kursbuch` bei Bedarf von Hand löschen.

## Für Entwickler: die Brücke

Im Installer steckt die Python-Seite als `learnweb-bridge.exe` (PyInstaller). Der Quelltext liegt in `bridge/` (bereinigter Schnappschuss, siehe README), der Release-Workflow baut ihn vor jedem Installer und führt `learnweb-bridge.exe selftest` aus (Tresor, Zertifikate, Suche, Dateileser, Datenordner; `selftest --net` prüft zusätzlich die Erreichbarkeit von LearnWeb).
