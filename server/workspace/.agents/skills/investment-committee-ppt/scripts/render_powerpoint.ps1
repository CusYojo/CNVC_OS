param(
  [Parameter(Mandatory = $true)][string]$InputPptx,
  [Parameter(Mandatory = $true)][string]$OutputPdf
)

$resolvedInput = (Resolve-Path -LiteralPath $InputPptx).Path
$absoluteOutput = [System.IO.Path]::GetFullPath($OutputPdf)
$outputDirectory = Split-Path -Parent $absoluteOutput
if (-not (Test-Path -LiteralPath $outputDirectory)) {
  [void](New-Item -ItemType Directory -Path $outputDirectory -Force)
}

$powerPoint = $null
$presentation = $null
try {
  $powerPoint = New-Object -ComObject PowerPoint.Application
  $powerPoint.Visible = -1
  $presentation = $powerPoint.Presentations.Open($resolvedInput, $true, $true, $false)
  $presentation.SaveAs($absoluteOutput, 32)
  Write-Output $absoluteOutput
}
finally {
  if ($null -ne $presentation) {
    $presentation.Close()
    [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($presentation)
  }
  if ($null -ne $powerPoint) {
    $powerPoint.Quit()
    [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($powerPoint)
  }
  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()
}
