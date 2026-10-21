# Baut die Python-Bruecke (learnweb.cli) zu einem eigenstaendigen Programm: bridge-dist\learnweb-bridge\learnweb-bridge.exe (PyInstaller, onedir).
# Kursbuch liefert dieses Verzeichnis im Installer mit (tauri.conf.json: bundle.resources) und ruft es statt `uv run python -m learnweb.cli` auf.
#   powershell -File tools\build-bridge.ps1                     # aus bridge\ (bereinigter Schnappschuss, siehe tools\sync-bridge.ps1)
#   powershell -File tools\build-bridge.ps1 -Source C:\Users\...\learnweb-mcp   # zum Ausprobieren aus der Arbeitskopie
param(
  [string]$Source = (Join-Path $PSScriptRoot '..\bridge'),
  [string]$Out = (Join-Path $PSScriptRoot '..\bridge-dist')
)
$ErrorActionPreference = 'Stop'
$uv = if (Get-Command uv -ErrorAction SilentlyContinue) { 'uv' } else { Join-Path $env:USERPROFILE '.local\bin\uv.exe' }
# Windows PowerShell 5.1 macht aus stderr-Zeilen (PyInstaller und uv melden dort den Fortschritt) Fehler; hier zaehlt nur der Exitcode
function Run { $e = $ErrorActionPreference; $ErrorActionPreference = 'Continue'; try { & $args[0] @($args[1..($args.Count - 1)]) 2>&1 | ForEach-Object { "$_" } } finally { $ErrorActionPreference = $e } }
$Source = (Resolve-Path $Source).Path
$work = Join-Path $env:TEMP 'learnweb-bridge-build'
if (Test-Path $work) { Remove-Item -Recurse -Force $work }
New-Item -ItemType Directory -Force $work | Out-Null
# kleiner Einstieg: dasselbe wie `python -m learnweb.cli`
$entry = Join-Path $work 'bridge_entry.py'
Set-Content -Path $entry -Encoding utf8 -Value "import sys`nfrom learnweb.cli import main`nsys.exit(main())"
Push-Location $Source
try {
  Run $uv sync --quiet
  if ($LASTEXITCODE -ne 0) { throw "uv sync ist fehlgeschlagen ($LASTEXITCODE)" }
  if (Test-Path (Join-Path $Out 'learnweb-bridge')) { Remove-Item -Recurse -Force (Join-Path $Out 'learnweb-bridge') }
  Run $uv run --with pyinstaller pyinstaller --noconfirm --clean --onedir --console --name learnweb-bridge `
    --distpath $Out --workpath (Join-Path $work 'build') --specpath $work `
    --paths $Source `
    --collect-all keyring --copy-metadata keyring --hidden-import win32ctypes.core `
    --collect-data certifi --collect-data docx --collect-data pptx `
    --exclude-module mcp --exclude-module pytest --exclude-module tkinter `
    $entry
  if ($LASTEXITCODE -ne 0) { throw "PyInstaller ist fehlgeschlagen ($LASTEXITCODE)" }
} finally { Pop-Location }
$exe = Join-Path $Out 'learnweb-bridge\learnweb-bridge.exe'
$mb = [math]::Round(((Get-ChildItem (Join-Path $Out 'learnweb-bridge') -Recurse | Measure-Object Length -Sum).Sum) / 1MB, 1)
Write-Host "Fertig: $exe ($mb MB)"
