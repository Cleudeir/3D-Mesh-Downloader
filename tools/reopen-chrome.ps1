# Espera o Chrome fechar e relanca com:
#   - perfil padrao do usuario (mantem o Browser MCP e a extensao instalada)
#   - --remote-debugging-port (automacao via CDP)
#   - --load-extension apontando para o dist deste projeto
#
# Uso: powershell -ExecutionPolicy Bypass -File tools\reopen-chrome.ps1 [esperaMaxSegundos]

$ErrorActionPreference = 'Stop'

$chrome = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
$extension = 'D:\Projetos\3d-mesh-downloader\dist'
$port = 9222
$url = 'https://studio.tripo3d.ai/workspace/generate/white-fluffy-dog-with-pink-bow-843c95e3-2c89-4ac4-997c-15a119fd0ea7'
$maxWait = if ($args.Count -ge 1) { [int]$args[0] } else { 120 }

Write-Output "Aguardando o Chrome fechar (limite ${maxWait}s)..."
$deadline = (Get-Date).AddSeconds($maxWait)
while ((Get-Process chrome -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 2
}

if (Get-Process chrome -ErrorAction SilentlyContinue) {
  Write-Output 'O Chrome ainda esta aberto; forcando fechamento...'
  Get-Process chrome -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep -Seconds 4
}

Write-Output "Iniciando o Chrome (perfil padrao + CDP na porta $port + extensao)..."
Start-Process -FilePath $chrome -ArgumentList @(
  "--remote-debugging-port=$port",
  "--load-extension=$extension",
  '--no-first-run',
  '--no-default-browser-check',
  $url
)

$ok = $false
for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Seconds 2
  try {
    $targets = Invoke-RestMethod "http://127.0.0.1:$port/json/list" -TimeoutSec 5
    $pages = $targets | Where-Object { $_.type -eq 'page' }
    Write-Output "CDP pronto: $($pages.Count) pagina(s)"
    $pages | Select-Object title, url | Format-Table -AutoSize
    $ok = $true
    break
  } catch {
    Write-Output -NoNewline '.'
  }
}

if (-not $ok) { Write-Output "`nA porta CDP nao respondeu."; exit 1 }
