$ErrorActionPreference = 'Stop'

$systemRustup = Get-Command rustup.exe -ErrorAction SilentlyContinue
if (-not $systemRustup) {
  throw '未找到 rustup。请先从 https://rustup.rs 安装 rustup，再重新运行 pnpm setup:rust。'
}

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$env:RUSTUP_HOME = Join-Path $projectRoot '.toolchains\rustup'
$env:CARGO_HOME = Join-Path $projectRoot '.toolchains\cargo'

& $systemRustup.Source toolchain install stable --profile minimal --component rustfmt --component clippy --target x86_64-pc-windows-msvc
exit $LASTEXITCODE
