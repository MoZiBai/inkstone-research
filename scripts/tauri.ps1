param(
  [Parameter(Position = 0)]
  [ValidateSet('dev', 'build')]
  [string]$Action = 'dev'
)

. (Join-Path $PSScriptRoot 'rust-environment.ps1')

$tauri = Join-Path $projectRoot 'node_modules\.bin\tauri.CMD'
if (-not (Test-Path -LiteralPath $tauri)) {
  throw '未找到项目内 Tauri CLI，请先运行 pnpm install。'
}

& $tauri $Action
exit $LASTEXITCODE
