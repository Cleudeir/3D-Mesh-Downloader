# Baixa o LLaMA-Mesh Q4_K_M (GGUF, ~4,9 GB) para models\ e mostra o comando
# do llama-server. Usa curl.exe (vem no Windows 10/11) com retomada de download.
#
# Uso:
#   powershell -ExecutionPolicy Bypass -File tools\download-llama-mesh.ps1
#   powershell -ExecutionPolicy Bypass -File tools\download-llama-mesh.ps1 -Token $env:HF_TOKEN
#   powershell -ExecutionPolicy Bypass -File tools\download-llama-mesh.ps1 -Run
#
# O download pode ser retomado: rode o mesmo comando de novo.

param(
  [string]$Dest = (Join-Path (Split-Path -Parent $PSScriptRoot) 'models\llama-mesh-q4_k_m.gguf'),
  [string]$Token = $env:HF_TOKEN,
  [switch]$Run,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'

$url = 'https://huggingface.co/trackdr/LLaMA-Mesh-Q4_K_M-GGUF/resolve/main/llama-mesh-q4_k_m.gguf?download=true'
$Dest = [System.IO.Path]::GetFullPath($Dest)
$dir = Split-Path -Parent $Dest
New-Item -ItemType Directory -Force -Path $dir | Out-Null

Write-Output "Modelo: LLaMA-Mesh Q4_K_M (GGUF, ~4,9 GB)"
Write-Output "Licenca: NSCLv1 (apenas uso nao comercial) + Llama 3.1"
Write-Output "Destino: $Dest"

$currentSize = if (Test-Path $Dest) { (Get-Item $Dest).Length } else { 0 }
$skipDownload = $currentSize -ge 4GB -and -not $Force
if ($skipDownload) {
  Write-Output 'Arquivo ja completo; pulando o download.'
}

$curl = Get-Command curl.exe -ErrorAction SilentlyContinue
if (-not $skipDownload -and $curl) {
  $curlArgs = @('-L', '--fail', '--retry', '5', '--retry-all-errors', '--retry-delay', '5', '-C', '-', '-o', $Dest)
  if ($Token) { $curlArgs += @('-H', "Authorization: Bearer $Token") }
  $curlArgs += $url

  Write-Output 'Baixando/retomando com curl...'
  & $curl.Source @curlArgs
  if ($LASTEXITCODE -ne 0) {
    throw "curl terminou com codigo $LASTEXITCODE. Se o arquivo estiver aberto em outro processo, feche-o e rode de novo."
  }
} elseif (-not $skipDownload) {
  Write-Output 'curl.exe nao encontrado; usando Invoke-WebRequest (sem retomada).'
  $headers = @{}
  if ($Token) { $headers['Authorization'] = "Bearer $Token" }
  Invoke-WebRequest -Uri $url -OutFile $Dest -Headers $headers -UseBasicParsing
}

if (-not (Test-Path $Dest)) { throw 'o arquivo nao foi criado' }
$size = (Get-Item $Dest).Length
if ($size -lt 4GB) {
  throw "download incompleto ($([math]::Round($size / 1GB, 2)) GB). Rode de novo para retomar."
}

Write-Output ''
Write-Output ("Pronto: {0:N2} GB" -f ($size / 1GB))
$cudaServer = Join-Path (Split-Path -Parent $PSScriptRoot) 'tools\llama-cuda\llama-server.exe'
$serverPath = if (Test-Path $cudaServer) { $cudaServer } else { '' }
$isCuda = $serverPath -ne ''

if (-not $serverPath) {
  $server = Get-Command llama-server -ErrorAction SilentlyContinue
  $serverPath = if ($server) { $server.Source } else { '' }
}
if (-not $serverPath) {
  # O winget atualiza o PATH, mas o processo atual pode nao enxergar ainda.
  $found = Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages" -Recurse -Filter 'llama-server.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($found) { $serverPath = $found.FullName }
}

$serverArgs = @(
  '-m', ('"{0}"' -f $Dest),
  '-c', '8192', '-np', '1', '-fa', 'on',
  '-ctk', 'q8_0', '-ctv', 'q8_0', '-ngl', '99',
  '-a', 'llama-mesh', '--host', '127.0.0.1', '--port', '8080'
)
if ($isCuda) { $serverArgs += @('-dev', 'CUDA0') }

if (-not $serverPath) {
  Write-Output ''
  Write-Output 'llama-server nao encontrado. Instale com: winget install llama.cpp'
  Write-Output 'Para o build CUDA (mais rapido em NVIDIA): npm run llama:cuda'
} else {
  Write-Output ''
  Write-Output 'Comando para iniciar o servidor local:'
  Write-Output ('  "{0}" {1}' -f $serverPath, ($serverArgs -join ' '))
  if ($Run) {
    Write-Output ''
    Write-Output 'Iniciando o llama-server...'
    Start-Process -FilePath $serverPath -ArgumentList $serverArgs
    Write-Output 'Servidor em http://127.0.0.1:8080/v1'
  }
}
