# Reinicia a instancia de depuracao do Chrome (perfil proprio em .chrome-debug),
# carrega a extensao deste projeto e abre a pagina do Tripo.
#
# Uso: powershell -ExecutionPolicy Bypass -File tools\relaunch-debug-chrome.ps1

$ErrorActionPreference = 'Stop'
$root = 'D:\Projetos\3d-mesh-downloader'
$chrome = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
$profile = "$root\.chrome-debug"
$ext = "$root\dist"
$downloads = "$root\.downloads"
$port = 9222
$url = 'https://studio.tripo3d.ai/workspace/generate/white-fluffy-dog-with-pink-bow-843c95e3-2c89-4ac4-997c-15a119fd0ea7'

Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
  Where-Object { $_.CommandLine -match 'chrome-debug' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 3

if (Test-Path $downloads) { Remove-Item "$downloads\*" -Force -Recurse -ErrorAction SilentlyContinue }
New-Item -ItemType Directory -Force -Path $downloads | Out-Null

Start-Process -FilePath $chrome -ArgumentList @(
  "--remote-debugging-port=$port",
  "--user-data-dir=$profile",
  "--enable-unsafe-extension-debugging",
  '--no-first-run',
  '--no-default-browser-check',
  $url
)

$ready = $false
for ($i = 0; $i -lt 25; $i++) {
  Start-Sleep -Seconds 2
  try {
    Invoke-RestMethod "http://127.0.0.1:$port/json/version" -TimeoutSec 4 | Out-Null
    $ready = $true
    break
  } catch { }
}
if (-not $ready) { Write-Output 'CDP nao respondeu'; exit 1 }

Write-Output 'CDP pronto; configurando downloads e extensao...'
Push-Location $root
node tools\cdp-setup.js $ext $downloads
Pop-Location
Write-Output "pronto - pagina alvo: $url"
