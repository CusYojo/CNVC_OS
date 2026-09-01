param(
    [Parameter(Mandatory = $true)]
    [string]$InputDocx,

    [Parameter(Mandatory = $true)]
    [string]$OutputPdf
)

$ErrorActionPreference = 'Stop'

$inputPath = [System.IO.Path]::GetFullPath($InputDocx)
$outputPath = [System.IO.Path]::GetFullPath($OutputPdf)

if ([System.IO.Path]::GetExtension($inputPath).ToLowerInvariant() -ne '.docx') {
    throw "InputDocx must be a .docx file: $inputPath"
}
if ([System.IO.Path]::GetExtension($outputPath).ToLowerInvariant() -ne '.pdf') {
    throw "OutputPdf must be a .pdf file: $outputPath"
}
if (-not (Test-Path -LiteralPath $inputPath -PathType Leaf)) {
    throw "Input DOCX not found: $inputPath"
}

$outputDirectory = [System.IO.Path]::GetDirectoryName($outputPath)
if (-not (Test-Path -LiteralPath $outputDirectory -PathType Container)) {
    [System.IO.Directory]::CreateDirectory($outputDirectory) | Out-Null
}

$word = $null
$document = $null

try {
    $word = New-Object -ComObject Word.Application
    $word.Visible = $false
    $word.DisplayAlerts = 0
    $document = $word.Documents.Open($inputPath, $false, $true)
    $document.ExportAsFixedFormat($outputPath, 17)
}
finally {
    if ($null -ne $document) {
        $document.Close($false)
        [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($document)
    }
    if ($null -ne $word) {
        $word.Quit()
        [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($word)
    }
    [GC]::Collect()
    [GC]::WaitForPendingFinalizers()
}

if (-not (Test-Path -LiteralPath $outputPath -PathType Leaf)) {
    throw "PDF export did not create a file: $outputPath"
}
if ((Get-Item -LiteralPath $outputPath).Length -le 0) {
    throw "PDF export created an empty file: $outputPath"
}

Write-Output $outputPath
