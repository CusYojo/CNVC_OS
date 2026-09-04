$projectRoot = Split-Path -Parent $PSScriptRoot
$nodeDirectory = Join-Path $projectRoot '.runtime\node22'
$nodeExecutable = Join-Path $nodeDirectory 'node.exe'
$commandParts = @($args)

if (-not (Test-Path -LiteralPath $nodeExecutable)) {
  throw "Project-local Node 22 is missing: $nodeExecutable"
}

$env:Path = "$nodeDirectory;$env:Path"

if ($commandParts.Count -eq 0) {
  Write-Output "Project Node: $(& $nodeExecutable -v)"
  Write-Output "Project npm:  $(& (Join-Path $nodeDirectory 'npm.cmd') -v)"
  Write-Output 'Usage: .\scripts\use-node22.ps1 npm run dev'
  exit 0
}

$executable = $commandParts[0]
[string[]] $commandArguments = @()
if ($commandParts.Count -gt 1) {
  $commandArguments = @($commandParts[1..($commandParts.Count - 1)])
}
& $executable @commandArguments
exit $LASTEXITCODE
