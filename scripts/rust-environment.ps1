$ErrorActionPreference = 'Stop'

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$env:RUSTUP_HOME = Join-Path $projectRoot '.toolchains\rustup'
$env:CARGO_HOME = Join-Path $projectRoot '.toolchains\cargo'
$env:PATH = "$(Join-Path $env:CARGO_HOME 'bin');$env:PATH"

$vswhere = 'C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe'
if (-not (Test-Path -LiteralPath $vswhere)) {
  throw '未找到 Visual Studio Installer，无法初始化 Windows MSVC 编译环境。'
}

$visualStudioPath = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $visualStudioPath) {
  throw '未找到包含 C++ 工具的 Visual Studio Build Tools。'
}

$developerCommand = Join-Path $visualStudioPath 'Common7\Tools\VsDevCmd.bat'
$environmentLines = & cmd.exe /s /c "`"$developerCommand`" -no_logo -arch=x64 && set"
foreach ($line in $environmentLines) {
  $separator = $line.IndexOf('=')
  if ($separator -gt 0) {
    $name = $line.Substring(0, $separator)
    $value = $line.Substring($separator + 1)
    Set-Item -Path "Env:$name" -Value $value
  }
}
