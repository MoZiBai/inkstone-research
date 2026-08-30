$rustupArguments = $args

. (Join-Path $PSScriptRoot 'rust-environment.ps1')

$rustup = Join-Path $env:CARGO_HOME 'bin\rustup.exe'
& $rustup @RustupArguments
exit $LASTEXITCODE
