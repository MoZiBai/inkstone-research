$cargoArguments = $args

. (Join-Path $PSScriptRoot 'rust-environment.ps1')

$cargo = Join-Path $env:CARGO_HOME 'bin\cargo.exe'
& $cargo @CargoArguments
exit $LASTEXITCODE
