# Schnappschuss der Python-Bruecke fuer das oeffentliche Repository: kopiert aus dem Entwicklungsordner (-Source) nach bridge/,
# ohne MCP-Server, Skripte, Anleitungen und persoenliche Angaben. Aus bridge/ baut tools/build-bridge.ps1 die learnweb-bridge.exe (auch im Release-Workflow).
# bridge/ nicht von Hand aendern: Aenderungen gehoeren in den Entwicklungsordner, dann dieses Skript erneut laufen lassen.
#
#   .\tools\sync-bridge.ps1 -Source C:\Pfad\zu\learnweb-mcp [-Kennung <Uni-Kennung>] [-NoTest]
#
# -Kennung (oder Umgebungsvariable LEARNWEB_KENNUNG): die echte Uni-Kennung. Sie steht nie in diesem Skript; hier dient sie nur dazu,
# sie zu ersetzen und zu pruefen, dass sie im Schnappschuss nirgends mehr vorkommt.
param(
    [Parameter(Mandatory)][string]$Source,
    [string]$Out = (Join-Path $PSScriptRoot '..\bridge'),
    [string]$Kennung = $env:LEARNWEB_KENNUNG,
    [switch]$NoTest
)
$ErrorActionPreference = 'Stop'
$Source = (Resolve-Path $Source).Path
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Out = [IO.Path]::GetFullPath($Out)
if ($Out -ne (Join-Path $repo 'bridge')) { throw "Ausgabeordner muss <Repository>\bridge sein (war: $Out)" }
foreach ($f in 'learnweb', 'tests', 'pyproject.toml', 'uv.lock') {
    if (-not (Test-Path (Join-Path $Source $f))) { throw "Im Quellordner fehlt $f ($Source)" }
}
$utf8 = New-Object System.Text.UTF8Encoding($false)
function Read-Text($p) { [IO.File]::ReadAllText($p, $utf8) }
function Write-Text($p, $t) { [IO.File]::WriteAllText($p, $t, $utf8) }
# Windows PowerShell 5.1 macht aus stderr-Zeilen (uv meldet dort den Fortschritt) Fehler; hier zaehlt nur der Exitcode
function Run { $e = $ErrorActionPreference; $ErrorActionPreference = 'Continue'; try { & $args[0] @($args[1..($args.Count - 1)]) 2>&1 | ForEach-Object { "$_" } } finally { $ErrorActionPreference = $e } }

if (Test-Path $Out) { Remove-Item -Recurse -Force $Out }
New-Item -ItemType Directory -Path $Out, "$Out\learnweb", "$Out\tests" | Out-Null

# nur Python-Quellen; server.py ist der MCP-Server fuer Claude und gehoert nicht in die App
Get-ChildItem "$Source\learnweb" -Filter *.py | Where-Object { $_.Name -ne 'server.py' } | Copy-Item -Destination "$Out\learnweb"
Get-ChildItem "$Source\tests" -Filter *.py | Copy-Item -Destination "$Out\tests"
Copy-Item "$Source\uv.lock", "$Source\pyproject.toml" -Destination $Out

# Abhaengigkeit mcp (nur fuer server.py) entfernen; uv aktualisiert die Sperrdatei, die uebrigen Versionen bleiben
$py = Read-Text "$Out\pyproject.toml"
$py = $py -replace '(?m)^\s*#[^\r\n]*mcp[^\r\n]*\r?\n', '' -replace '(?m)^\s*"mcp\[cli\][^\r\n]*\r?\n', ''
$py = $py -replace 'name = "learnweb-mcp"', 'name = "learnweb-bridge"' -replace '(?m)^description = .*$', 'description = "Python-Bruecke von Kursbuch: Anmeldung, Abgleich und Suche fuer LearnWeb (Uni Muenster)"'
Write-Text "$Out\pyproject.toml" $py
Push-Location $Out
try { Run uv lock --quiet; if ($LASTEXITCODE) { throw 'uv lock schlug fehl' } } finally { Pop-Location }

# Uni-Kennung im Test durch einen Platzhalter ersetzen (allgemein: erstes Argument von Credentials(...))
$t = Read-Text "$Out\tests\test_client.py"
Write-Text "$Out\tests\test_client.py" ($t -replace 'Credentials\("[^"]+",', 'Credentials("abc123",')

Write-Text "$Out\.gitignore" ".venv/`ndata/`n__pycache__/`n.pytest_cache/`n.hypothesis/`n*.part`n"
Write-Text "$Out\README.md" @"
# Python-Bruecke (Schnappschuss)

Der Teil von Kursbuch, der mit LearnWeb spricht: Anmeldung, Abgleich, Index, Suche (``learnweb.cli``, JSON auf stdout).
Daraus baut ``tools/build-bridge.ps1`` die ``learnweb-bridge.exe``, die im Installer mitgeliefert wird.

Dieser Ordner ist ein Schnappschuss aus dem Entwicklungsordner (``tools/sync-bridge.ps1``); bitte nicht von Hand aendern.
Tests: ``uv run pytest`` in diesem Ordner.
"@

# Pruefung: keine persoenlichen Angaben im Schnappschuss
$verboten = @($env:USERNAME, $env:USERPROFILE, $Kennung) | Where-Object { $_ }
$treffer = Get-ChildItem $Out -Recurse -File | Where-Object { $_.Name -ne 'uv.lock' } | ForEach-Object {
    $txt = Read-Text $_.FullName
    foreach ($v in $verboten) { if ($txt -match [regex]::Escape($v)) { "$($_.FullName.Substring($Out.Length + 1)): enthaelt '$($v.Substring(0, [Math]::Min(2, $v.Length)))...'" } }
}
if ($treffer) { throw ("Persoenliche Angaben im Schnappschuss:`n" + ($treffer -join "`n")) }

if (-not $NoTest) {
    Push-Location $Out
    try { Run uv run --group dev pytest -q; if ($LASTEXITCODE) { throw 'Tests im Schnappschuss schlugen fehl' } } finally { Pop-Location }
}
Write-Host "bridge/ aktualisiert: $((Get-ChildItem "$Out\learnweb", "$Out\tests" -Filter *.py | Measure-Object).Count) Python-Dateien"
