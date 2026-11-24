# Baixa o llama.cpp com backend CUDA para Windows x64 e extrai em tools\llama-cuda.
# O build do winget e Vulkan; em NVIDIA o CUDA e bem mais rapido.
#
# Uso:
#   powershell -ExecutionPolicy Bypass -File tools\setup-llama-cuda.ps1
#   powershell -ExecutionPolicy Bypass -File tools\setup-llama-cuda.ps1 -Cuda 12.4
#   powershell -ExecutionPolicy Bypass -File tools\setup-llama-cuda.ps1 -Force
#
# Requer driver NVIDIA compativel com a versao do CUDA escolhida.
# Se o llama-server estiver rodando, pare-o antes de usar -Force.

param(
  [string]$Cuda = '13.4',
  [string]$Dest = (Join-Path (Split-Path -Parent $PSScriptRoot) 'tools\llama-cuda'),
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$version = 'b12032'
$base = "https://github.com/ggml-org/llama.cpp/releases/download/$version"
$files = @(
  "llama-$version-bin-win-cuda-$Cuda-x64.zip",
  "cudart-llama-bin-win-cuda-$Cuda-x64.zip"
)
$tmp = Join-Path $env:TEMP "llama-cuda-$version-$Cuda"

New-Item -ItemType Directory -Force -Path $Dest | Out-Null
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$server = Join-Path $Dest 'llama-server.exe'

if ((Test-Path $server) -and -not $Force) {
  Write-Output "llama.cpp CUDA ja instalado em: $Dest"
  Write-Output 'Use -Force para baixar e extrair de novo (pare o llama-server antes).'
} else {
  $curl = (Get-Command curl.exe -ErrorAction SilentlyContinue).Source
  if (-not $curl) { throw 'curl.exe nao encontrado (Windows 10/11 deveria trazer)' }

  foreach ($file in $files) {
    $zip = Join-Path $tmp $file
    if (Test-Path $zip) {
      Write-Output "ja baixado: $file"
      continue
    }
    Write-Output "baixando $file ..."
    & $curl -L --fail --retry 5 --retry-all-errors --retry-delay 5 -o $zip "$base/$file"
    if ($LASTEXITCODE -ne 0) { throw "curl falhou em $file (codigo $LASTEXITCODE)" }
  }

  foreach ($file in $files) {
    $zip = Join-Path $tmp $file
    Write-Output "extraindo $file ..."
    Expand-Archive -LiteralPath $zip -DestinationPath $Dest -Force
  }

  if (-not (Test-Path $server)) {
    throw "llama-server.exe nao encontrado em $Dest"
  }
}

Write-Output ''
Write-Output "llama.cpp CUDA em: $Dest"
cmd /c "`"$server`" --version 2>&1" | Select-Object -First 3
Write-Output ''
Write-Output 'Dispositivos:'
cmd /c "`"$server`" --list-devices 2>&1" | Select-Object -First 12
Write-Output ''
Write-Output 'Comando sugerido (contexto 8192 + KV q8_0):'
$command = '  "{0}" -m "D:\Projetos\3d-mesh-downloader\models\llama-mesh-q4_k_m.gguf" ' +
  '-c 8192 -np 1 -fa on -ctk q8_0 -ctv q8_0 -ngl 99 -dev CUDA0 -a llama-mesh ' +
  '--host 127.0.0.1 --port 8080'
Write-Output ($command -f $server)
