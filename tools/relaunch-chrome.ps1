# Reinicia o Chrome do usuario com:
#   - a extensao descompactada deste projeto recarregada do disco (codigo novo)
#   - porta de depuracao CDP (9222) para automatizar via DevTools Protocol
#
# Uso:  powershell -ExecutionPolicy Bypass -File tools\relaunch-chrome.ps1
#
# O Chrome reabre com as abas da sessao anterior restauradas.

$ErrorActionPreference = 'Stop'

$chrome = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
$profile = "$env:LOCALAPPDATA\Google\Chrome\User Data"
$extension = 'D:\Projetos\3d-mesh-downloader\dist'
$port = 9222

if (-not (Test-Path $chrome)) { throw "Chrome nao encontrado em $chrome" }
if (-not (Test-Path $extension)) { throw "Extensao nao encontrada em $extension" }

Write-Output 'Fechando o Chrome...'
Get-Process chrome -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 4

Write-Output "Iniciando o Chrome com --remote-debugging-port=$port e a extensao carregada..."
$args = @(
  "--remote-debugging-port=$port",
  "--user-data-dir=$profile",
  "--load-extension=$extension",
  '--no-first-run',
  '--no-default-browser-check',
  'https://studio.tripo3d.ai/workspace/generate/white-fluffy-dog-with-pink-bow-843c95e3-2c89-4ac4-997c-15a119fd0ea7'
)
Start-Process -FilePath $chrome -ArgumentList $args

Start-Sleep -Seconds 8
try {
  $targets = Invoke-RestMethod "http://127.0.0.1:$port/json/list" -TimeoutSec 10
  Write-Output "CDP pronto em http://127.0.0.1:$port - $($targets.Count) alvo(s)"
  $targets | Where-Object { $_.type -eq 'page' } | Select-Object title, url | Format-Table -AutoSize
} catch {
  Write-Output "A porta CDP ainda nao respondeu: $_"
}
