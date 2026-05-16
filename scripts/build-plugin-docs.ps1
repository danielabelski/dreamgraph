# Build the DreamGraph Plugin Developer documentation suite.
#
# Inputs:
#   docs/sdk/plugin-developer-guide/*.md
#   docs/sdk/plugin-reference/*.md
#
# Outputs:
#   docs/sdk/site/html/plugin-developer-guide/*.html   (cross-linked)
#   docs/sdk/site/html/plugin-reference/*.html         (cross-linked)
#   docs/sdk/site/html/index.html                      (landing page)
#   docs/sdk/site/html/style.css                       (shared stylesheet)
#   docs/sdk/site/pdf/dreamgraph-plugin-developer-manual.pdf
#   docs/sdk/site/pdf/dreamgraph-plugin-developer-manual.html (intermediate)
#
# Requires: pandoc on PATH. PDF generation prefers, in order:
#   1. wkhtmltopdf
#   2. xelatex / pdflatex
#   3. Chromium (Edge / Chrome) headless print-to-pdf

[CmdletBinding()]
param(
  [switch]$SkipPdf
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$docRoot  = Join-Path $repoRoot "docs\sdk"
$guideDir = Join-Path $docRoot "plugin-developer-guide"
$refDir   = Join-Path $docRoot "plugin-reference"
$siteDir  = Join-Path $docRoot "site"
$htmlDir  = Join-Path $siteDir "html"
$pdfDir   = Join-Path $siteDir "pdf"

if (-not (Get-Command pandoc -ErrorAction SilentlyContinue)) {
  throw "pandoc not found on PATH. Install via: winget install pandoc"
}

# Clean and recreate output dirs.
foreach ($d in @($siteDir, $htmlDir, (Join-Path $htmlDir "plugin-developer-guide"), (Join-Path $htmlDir "plugin-reference"), $pdfDir)) {
  if (Test-Path $d) { Remove-Item -Recurse -Force $d }
  New-Item -ItemType Directory -Path $d -Force | Out-Null
}

# --- Shared CSS ---------------------------------------------------------------

$css = @'
:root { --fg:#222; --muted:#666; --accent:#3b6ea8; --bg:#fff; --code-bg:#f5f5f5; --border:#e1e1e1; }
@media (prefers-color-scheme: dark) {
  :root { --fg:#e8e8e8; --muted:#999; --accent:#7aa6d8; --bg:#1a1a1a; --code-bg:#252525; --border:#333; }
}
html, body { background: var(--bg); color: var(--fg); }
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
       max-width: 880px; margin: 2em auto; padding: 0 1.5em; line-height: 1.55; font-size: 16px; }
h1, h2, h3, h4 { color: var(--fg); line-height: 1.25; margin-top: 1.6em; }
h1 { border-bottom: 2px solid var(--accent); padding-bottom: 0.3em; }
h2 { border-bottom: 1px solid var(--border); padding-bottom: 0.2em; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
code { background: var(--code-bg); padding: 0.1em 0.35em; border-radius: 3px; font-size: 0.92em;
       font-family: "Cascadia Mono", Consolas, "Courier New", monospace; }
pre { background: var(--code-bg); padding: 1em; border-radius: 5px; overflow-x: auto; border: 1px solid var(--border); }
pre code { padding: 0; background: transparent; }
table { border-collapse: collapse; margin: 1em 0; width: 100%; }
th, td { border: 1px solid var(--border); padding: 0.45em 0.7em; text-align: left; vertical-align: top; }
th { background: var(--code-bg); }
blockquote { border-left: 4px solid var(--accent); margin: 1em 0; padding: 0.4em 1em; color: var(--muted); background: var(--code-bg); }
nav#TOC { background: var(--code-bg); padding: 1em 1.5em; border-radius: 5px; border: 1px solid var(--border); }
hr { border: 0; border-top: 1px solid var(--border); margin: 2em 0; }
.title { color: var(--accent); }
'@

Set-Content -Path (Join-Path $htmlDir "style.css") -Value $css -Encoding UTF8

# --- Lua filter: rewrite .md links to .html ----------------------------------

$lua = @'
function Link(el)
  local target = el.target
  if target and target:match("%.md$") and not target:match("^https?://") then
    el.target = target:gsub("%.md$", ".html"):gsub("%.md#", ".html#")
  elseif target and target:match("%.md#") and not target:match("^https?://") then
    el.target = target:gsub("%.md#", ".html#")
  end
  return el
end
'@

$luaPath = Join-Path $siteDir "rewrite-md-links.lua"
Set-Content -Path $luaPath -Value $lua -Encoding UTF8

# --- Helper: render one .md to one .html -------------------------------------

function Add-Utf8Bom {
  param([Parameter(Mandatory)] [string] $Path)
  $bom   = [byte[]](0xEF, 0xBB, 0xBF)
  $bytes = [System.IO.File]::ReadAllBytes($Path)
  if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) { return }
  [System.IO.File]::WriteAllBytes($Path, $bom + $bytes)
}

function Convert-MdToHtml {
  param(
    [Parameter(Mandatory)] [string] $InputFile,
    [Parameter(Mandatory)] [string] $OutputFile,
    [Parameter(Mandatory)] [string] $CssRelative
  )

  & pandoc `
    --from=gfm+yaml_metadata_block `
    --to=html5 `
    --standalone `
    --toc `
    --toc-depth=3 `
    --css=$CssRelative `
    --lua-filter="$luaPath" `
    --metadata=lang:en `
    --output="$OutputFile" `
    "$InputFile"

  if ($LASTEXITCODE -ne 0) { throw "pandoc failed for $InputFile" }
  # Some viewers (and Chromium's headless print pipeline on Windows) ignore
  # the inline <meta charset="utf-8"> when loading file:// URIs. Prepending a
  # UTF-8 BOM forces unambiguous detection.
  Add-Utf8Bom -Path $OutputFile
}

# --- Build per-file HTML ------------------------------------------------------

Write-Host "Rendering Plugin Developer Guide..." -ForegroundColor Cyan
Get-ChildItem -Path $guideDir -Filter "*.md" | Sort-Object Name | ForEach-Object {
  $out = Join-Path $htmlDir "plugin-developer-guide\$($_.BaseName).html"
  Convert-MdToHtml -InputFile $_.FullName -OutputFile $out -CssRelative "../style.css"
  Write-Host "  -> $($_.BaseName).html"
}

Write-Host "Rendering Plugin Reference Manual..." -ForegroundColor Cyan
Get-ChildItem -Path $refDir -Filter "*.md" | Sort-Object Name | ForEach-Object {
  $out = Join-Path $htmlDir "plugin-reference\$($_.BaseName).html"
  Convert-MdToHtml -InputFile $_.FullName -OutputFile $out -CssRelative "../style.css"
  Write-Host "  -> $($_.BaseName).html"
}

# --- Landing index page -------------------------------------------------------

$landing = @'
---
title: DreamGraph Plugin Developer Documentation
---

# DreamGraph Plugin Developer Documentation

Engine baseline: **v10.0.1 "Renata"**.

## Plugin Developer Guide

Task-oriented walkthroughs for building, installing, and operating plugins.

- [00 Index](plugin-developer-guide/00-index.html)
- [01 Introduction](plugin-developer-guide/01-introduction.html)
- [02 Quickstart — Hello Events](plugin-developer-guide/02-quickstart.html)
- [03 Anatomy of a plugin](plugin-developer-guide/03-anatomy.html)
- [04 Manifest and capabilities](plugin-developer-guide/04-manifest-and-capabilities.html)
- [05 The PluginContext](plugin-developer-guide/05-plugin-context.html)
- [06 Seams: tools and resources](plugin-developer-guide/06-seams-tools-resources.html)
- [07 Seams: events](plugin-developer-guide/07-seams-events.html)
- [08 Closure seams: UI, policies, archetypes, fences](plugin-developer-guide/08-seams-closure.html)
- [09 Trust and security model](plugin-developer-guide/09-trust-and-security.html)
- [10 Installation and lifecycle](plugin-developer-guide/10-lifecycle-and-installation.html)
- [11 Telemetry, debugging, testing](plugin-developer-guide/11-telemetry-debugging-testing.html)
- [12 Best practices and pitfalls](plugin-developer-guide/12-best-practices.html)

## Plugin Reference Manual

Strict, normative tables. Source of truth for every constraint.

- [00 Index](plugin-reference/00-index.html)
- [01 Manifest schema](plugin-reference/01-manifest-schema.html)
- [02 Capabilities](plugin-reference/02-capabilities.html)
- [03 Effects](plugin-reference/03-effects.html)
- [04 Reject reasons](plugin-reference/04-reject-reasons.html)
- [05 PluginContext API](plugin-reference/05-context-api.html)
- [06 Events](plugin-reference/06-events.html)
- [07 `dg plugin` CLI](plugin-reference/07-cli.html)
- [08 Host configuration](plugin-reference/08-host-config.html)
- [09 Telemetry events](plugin-reference/09-telemetry-events.html)

## PDF

A single-volume PDF combining both books is available at
`pdf/dreamgraph-plugin-developer-manual.pdf` after running
`scripts/build-plugin-docs.ps1`.
'@

$landingMd = Join-Path $siteDir "_landing.md"
Set-Content -Path $landingMd -Value $landing -Encoding UTF8
Convert-MdToHtml -InputFile $landingMd -OutputFile (Join-Path $htmlDir "index.html") -CssRelative "style.css"
Remove-Item $landingMd -Force

# --- Combined manuscript for PDF ---------------------------------------------

if ($SkipPdf) {
  Write-Host "Skipping PDF build (per -SkipPdf)." -ForegroundColor Yellow
  Write-Host "HTML output: $htmlDir" -ForegroundColor Green
  return
}

Write-Host "Assembling combined manuscript..." -ForegroundColor Cyan

$combined = New-Object System.Text.StringBuilder
[void]$combined.AppendLine("---")
[void]$combined.AppendLine("title: DreamGraph Plugin Developer Manual")
[void]$combined.AppendLine("subtitle: Guide and Reference Manual --- v10.0.1 Renata")
[void]$combined.AppendLine("---")
[void]$combined.AppendLine("")
[void]$combined.AppendLine("# Part I --- Plugin Developer Guide")
[void]$combined.AppendLine("")

Get-ChildItem -Path $guideDir -Filter "*.md" | Sort-Object Name | ForEach-Object {
  $body = [System.IO.File]::ReadAllText($_.FullName, [System.Text.Encoding]::UTF8)
  # Strip in-page nav lines like "[← Foo](...) · [Next →](...)" and
  # cross-doc relative links (..\plugin-reference) that won't resolve in PDF.
  $body = $body -replace '(?m)^\[\u2190.*$', ''
  $body = $body -replace '(?m)^\[Index.*$', ''
  [void]$combined.AppendLine("")
  [void]$combined.AppendLine("\newpage")
  [void]$combined.AppendLine("")
  [void]$combined.AppendLine($body)
}

[void]$combined.AppendLine("")
[void]$combined.AppendLine("\newpage")
[void]$combined.AppendLine("")
[void]$combined.AppendLine("# Part II --- Plugin Reference Manual")
[void]$combined.AppendLine("")

Get-ChildItem -Path $refDir -Filter "*.md" | Sort-Object Name | ForEach-Object {
  $body = [System.IO.File]::ReadAllText($_.FullName, [System.Text.Encoding]::UTF8)
  $body = $body -replace '(?m)^\[\u2190.*$', ''
  $body = $body -replace '(?m)^\[Index.*$', ''
  [void]$combined.AppendLine("")
  [void]$combined.AppendLine("\newpage")
  [void]$combined.AppendLine("")
  [void]$combined.AppendLine($body)
}

$combinedMd   = Join-Path $pdfDir "dreamgraph-plugin-developer-manual.md"
$combinedHtml = Join-Path $pdfDir "dreamgraph-plugin-developer-manual.html"
$combinedPdf  = Join-Path $pdfDir "dreamgraph-plugin-developer-manual.pdf"

# Write combined MD as UTF-8 with BOM so any downstream tool detects it correctly.
[System.IO.File]::WriteAllText($combinedMd, $combined.ToString(), (New-Object System.Text.UTF8Encoding($true)))

# Copy CSS into pdfDir so the standalone HTML can reference it.
Copy-Item (Join-Path $htmlDir "style.css") (Join-Path $pdfDir "style.css") -Force

Write-Host "Rendering combined HTML..." -ForegroundColor Cyan
& pandoc `
  --from=gfm+yaml_metadata_block `
  --to=html5 `
  --standalone `
  --toc `
  --toc-depth=2 `
  --css=style.css `
  --metadata=lang:en `
  --output="$combinedHtml" `
  "$combinedMd"
if ($LASTEXITCODE -ne 0) { throw "pandoc combined HTML failed" }
Add-Utf8Bom -Path $combinedHtml

# --- Detect a PDF engine ------------------------------------------------------

function Find-PdfEngine {
  foreach ($cmd in @("wkhtmltopdf","xelatex","pdflatex")) {
    $c = Get-Command $cmd -ErrorAction SilentlyContinue
    if ($c) { return @{ Kind = $cmd; Path = $c.Source } }
  }
  $chromium = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
  ) | Where-Object { Test-Path $_ } | Select-Object -First 1
  if ($chromium) { return @{ Kind = "chromium"; Path = $chromium } }
  return $null
}

$engine = Find-PdfEngine

if (-not $engine) {
  Write-Warning "No PDF engine found. Install one of:"
  Write-Warning "  winget install --id wkhtmltopdf.wkhtmltox"
  Write-Warning "  winget install --id MiKTeX.MiKTeX           (provides xelatex/pdflatex)"
  Write-Warning "  Or any Chromium-based browser (Edge / Chrome)."
  Write-Warning "Combined HTML written to: $combinedHtml"
  return
}

Write-Host "Rendering PDF via $($engine.Kind)..." -ForegroundColor Cyan

switch ($engine.Kind) {
  "wkhtmltopdf" {
    & wkhtmltopdf --enable-local-file-access "$combinedHtml" "$combinedPdf"
    if ($LASTEXITCODE -ne 0) { throw "wkhtmltopdf failed" }
  }
  "xelatex"     {
    & pandoc --from=gfm+yaml_metadata_block --pdf-engine=xelatex --toc --toc-depth=2 --output="$combinedPdf" "$combinedMd"
    if ($LASTEXITCODE -ne 0) { throw "pandoc xelatex failed" }
  }
  "pdflatex"    {
    & pandoc --from=gfm+yaml_metadata_block --pdf-engine=pdflatex --toc --toc-depth=2 --output="$combinedPdf" "$combinedMd"
    if ($LASTEXITCODE -ne 0) { throw "pandoc pdflatex failed" }
  }
  "chromium"    {
    # Chromium needs a file:// URI. It writes a one-line diagnostic to stderr
    # on success, which PowerShell would otherwise treat as an error.
    $fileUri = ([Uri]$combinedHtml).AbsoluteUri
    $oldErr  = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
      & "$($engine.Path)" --headless --disable-gpu --no-pdf-header-footer --print-to-pdf="$combinedPdf" "$fileUri" 2>$null | Out-Null
    } finally {
      $ErrorActionPreference = $oldErr
    }
    if (-not (Test-Path $combinedPdf)) { throw "Chromium headless print-to-pdf produced no file" }
  }
}

Write-Host ""
Write-Host "Done." -ForegroundColor Green
Write-Host "  HTML site: $htmlDir"
Write-Host "  PDF      : $combinedPdf"
