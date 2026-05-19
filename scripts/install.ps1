#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Install DreamGraph globally to ~/.dreamgraph/bin/

.DESCRIPTION
    Builds the project, deploys compiled files to the global bin directory,
    installs production dependencies, creates PATH entries, and attempts to
    package/install the VS Code extension using the most reliable CLI available.

    The installer is designed for fail-safe behavior:
    - hard-fails on core DreamGraph install problems
    - degrades gracefully for optional VS Code extension installation
    - avoids partial extension activation claims unless installation is verified

.PARAMETER SourceDir
    Path to the DreamGraph source repository (default: parent of this script)

.PARAMETER Force
    Overwrite existing installation without prompting

.EXAMPLE
    .\scripts\install.ps1
    .\scripts\install.ps1 -SourceDir C:\repos\dreamgraph -Force
#>

param(
    [string]$SourceDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
    [switch]$Force
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

# -- Config ----------------------------------------------------------
$DGHome         = if ($env:DREAMGRAPH_MASTER_DIR) { $env:DREAMGRAPH_MASTER_DIR } else { Join-Path $env:USERPROFILE ".dreamgraph" }
$BinDir         = Join-Path $DGHome "bin"
$DistTarget     = Join-Path $BinDir "dist"
$TemplateTarget = Join-Path $DGHome "templates"
$VsCodeCliHints = @(
    "code.cmd",
    "code"
)

# -- Helpers ---------------------------------------------------------
function Write-Step([string]$msg) { Write-Host "`n$msg" -ForegroundColor Cyan }
function Write-Ok([string]$msg)   { Write-Host "  $msg (ok)" -ForegroundColor Green }
function Write-Warn([string]$msg) { Write-Host "  WARNING: $msg" -ForegroundColor Yellow }
function Stop-Install([string]$msg) { Write-Error $msg; exit 1 }
function Get-ArrayCount {
    param([AllowNull()]$Value)
    if ($null -eq $Value) { return 0 }
    return @($Value).Count
}

function Invoke-LoggedCommand {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$Arguments = @(),
        [string]$WorkingDirectory = $SourceDir,
        [switch]$AllowFailure,
        [switch]$Quiet
    )

    $output = @()
    $exitCode = 0
    Push-Location $WorkingDirectory
    try {
        $prevPref = $ErrorActionPreference
        $originalEncoding = [Console]::OutputEncoding
        $originalInputEncoding = [Console]::InputEncoding
        $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
        [Console]::OutputEncoding = $utf8NoBom
        [Console]::InputEncoding = $utf8NoBom
        $OutputEncoding = $utf8NoBom
        $ErrorActionPreference = "SilentlyContinue"
        $output = & $FilePath @Arguments 2>&1
        $exitCode = $LASTEXITCODE
        if ($null -eq $exitCode) {
            $exitCode = 0
        }
        $ErrorActionPreference = $prevPref
        [Console]::OutputEncoding = $originalEncoding
        [Console]::InputEncoding = $originalInputEncoding
    } finally {
        Pop-Location
    }

    if (-not $Quiet) {
        @($output) | Where-Object { $_ -is [string] -and $_.Trim() } | ForEach-Object {
            Write-Host "  $_" -ForegroundColor DarkGray
        }
    }

    if (-not $AllowFailure -and $exitCode -ne 0) {
        Stop-Install "$FilePath $($Arguments -join ' ') failed with exit code $exitCode"
    }

    return [pscustomobject]@{
        ExitCode = $exitCode
        Output   = @($output)
    }
}

function Test-CommandAvailable([string]$Name) {
    return $null -ne (Get-Command $Name -ErrorAction SilentlyContinue)
}

function Initialize-RootBuildDependencies {
    $requiredPaths = @(
        (Join-Path $SourceDir "node_modules"),
        (Join-Path $SourceDir "node_modules\typescript"),
        (Join-Path $SourceDir "node_modules\@types\node"),
        (Join-Path $SourceDir "node_modules\zod"),
        (Join-Path $SourceDir "node_modules\@modelcontextprotocol")
    )

    $missing = @($requiredPaths | Where-Object { -not (Test-Path $_) })
    if ((Get-ArrayCount $missing) -gt 0) {
        Write-Host "  Installing root npm dependencies (including devDependencies)..." -ForegroundColor Cyan
        $result = Invoke-LoggedCommand -FilePath "npm" -Arguments @("install", "--include=dev", "--loglevel=warn") -WorkingDirectory $SourceDir
        if ($result.ExitCode -ne 0) {
            Stop-Install "Root npm install failed (exit code $($result.ExitCode))"
        }
        Write-Ok "Root build dependencies installed"
    }
}

function Resolve-VsCodeCli {
    foreach ($candidate in $VsCodeCliHints) {
        $cmd = Get-Command $candidate -ErrorAction SilentlyContinue
        if ($cmd) {
            return $cmd.Source
        }
    }

    $userPrograms = Join-Path $env:LOCALAPPDATA "Programs\Microsoft VS Code\bin\code.cmd"
    if (Test-Path $userPrograms) { return $userPrograms }

    $machinePrograms = "C:\Program Files\Microsoft VS Code\bin\code.cmd"
    if (Test-Path $machinePrograms) { return $machinePrograms }

    return $null
}

function Test-CanBuildVsCodeExtension {
    $extSourceDir = Join-Path $SourceDir "extensions\vscode"
    return (Test-Path $extSourceDir)
}

function Initialize-ExtensionBuildDependencies {
    $extSourceDir = Join-Path $SourceDir "extensions\vscode"
    $tsPath = Join-Path $extSourceDir "node_modules\typescript"
    $esbuildPath = Join-Path $extSourceDir "node_modules\esbuild"
    $vscePath = Join-Path $extSourceDir "node_modules\@vscode\vsce"
    if ((-not (Test-Path $tsPath)) -or (-not (Test-Path $esbuildPath)) -or (-not (Test-Path $vscePath))) {
        Write-Host "  Installing VS Code extension build dependencies..." -ForegroundColor Cyan
        $result = Invoke-LoggedCommand -FilePath "npm" -Arguments @("install", "--loglevel=warn") -WorkingDirectory $extSourceDir
        if ($result.ExitCode -ne 0) {
            Stop-Install "VS Code extension npm install failed (exit code $($result.ExitCode))"
        }
        Write-Ok "VS Code extension build dependencies installed"
    }
}

function Remove-LegacyVsCodeExtensionArtifacts {
    param(
        [string]$ExtensionId,
        [string]$LegacyVersion
    )

    $extensionsRoots = @(
        (Join-Path $env:USERPROFILE ".vscode\extensions"),
        (Join-Path $env:USERPROFILE ".vscode-insiders\extensions")
    ) | Where-Object { Test-Path $_ }

    foreach ($extensionsRoot in $extensionsRoots) {
        $legacyPattern = "$ExtensionId-$LegacyVersion*"
        $legacyDirs = Get-ChildItem -Path $extensionsRoot -Directory -Filter $legacyPattern -ErrorAction SilentlyContinue
        foreach ($dir in @($legacyDirs)) {
            try {
                Remove-Item -Recurse -Force $dir.FullName
                Write-Ok "Removed legacy extension folder $($dir.Name)"
            } catch {
                Write-Warn "Failed to remove legacy extension folder $($dir.FullName): $_"
            }
        }
    }
}

function Test-VsCodeExtensionInstalled {
    param(
        [Parameter(Mandatory = $true)][string]$CodeCli,
        [Parameter(Mandatory = $true)][string]$ExtensionId,
        [Parameter(Mandatory = $true)][string]$Version
    )

    $result = Invoke-LoggedCommand -FilePath $CodeCli -Arguments @("--list-extensions", "--show-versions") -AllowFailure -Quiet
    if ($result.ExitCode -ne 0) {
        return $false
    }

    $pattern = "^$([regex]::Escape($ExtensionId))@$([regex]::Escape($Version))$"
    return @($result.Output) -match $pattern
}

function Install-VsCodeExtensionSafely {
    param(
        [Parameter(Mandatory = $true)][string]$CodeCli,
        [Parameter(Mandatory = $true)][string]$VsixPath,
        [Parameter(Mandatory = $true)][string]$ExtensionId,
        [Parameter(Mandatory = $true)][string]$Version
    )

    Invoke-LoggedCommand -FilePath $CodeCli -Arguments @("--uninstall-extension", $ExtensionId, "--force") -AllowFailure -Quiet | Out-Null

    $installResult = Invoke-LoggedCommand -FilePath $CodeCli -Arguments @("--install-extension", $VsixPath, "--force") -AllowFailure
    if ($installResult.ExitCode -ne 0) {
        return $false
    }

    return (Test-VsCodeExtensionInstalled -CodeCli $CodeCli -ExtensionId $ExtensionId -Version $Version)
}

# -- Prerequisites ---------------------------------------------------
Write-Step "Checking prerequisites..."

$nodeVersion = & node --version 2>$null
if (-not $nodeVersion) {
    Stop-Install "Node.js is required but not found. Install from https://nodejs.org/"
}
$major = [int]($nodeVersion -replace '^v(\d+)\..*', '$1')
if ($major -lt 20) {
    Stop-Install "Node.js >= 20 required (found $nodeVersion). Install Node 20 LTS or newer from https://nodejs.org/"
}
Write-Ok "Node.js $nodeVersion"

$npmVersion = & npm --version 2>$null
if (-not $npmVersion) {
    Stop-Install "npm is required but not found."
}
Write-Ok "npm $npmVersion"

# -- Validate source ------------------------------------------------
$packageJsonPath = Join-Path $SourceDir "package.json"
if (-not (Test-Path $packageJsonPath)) {
    Stop-Install "No package.json found at $SourceDir. Is this the DreamGraph repo?"
}

$pkg = Get-Content $packageJsonPath -Raw | ConvertFrom-Json
if ($pkg.name -ne "dreamgraph") {
    Stop-Install "package.json does not appear to be DreamGraph (name: $($pkg.name))"
}
$version = $pkg.version
Write-Ok "DreamGraph v$version source at $SourceDir"

# -- Check existing install -----------------------------------------
if ((Test-Path $DistTarget) -and -not $Force) {
    $existingVersion = "unknown"
    $versionFile = Join-Path $BinDir "version.json"
    if (Test-Path $versionFile) {
        $existingVersion = (Get-Content $versionFile -Raw | ConvertFrom-Json).version
    }
    Write-Warn "Existing installation found (v$existingVersion)"
    $confirm = Read-Host "  Overwrite? [y/N]"
    if ($confirm -ne "y" -and $confirm -ne "Y") {
        Write-Host "Aborted." -ForegroundColor Red
        exit 0
    }
}

# -- Build ----------------------------------------------------------
Write-Step "Building DreamGraph..."
Initialize-RootBuildDependencies
$result = Invoke-LoggedCommand -FilePath "npm" -Arguments @("run", "build") -WorkingDirectory $SourceDir
if ($result.ExitCode -ne 0) {
    Stop-Install "Build failed with exit code $($result.ExitCode)"
}
Write-Ok "Build complete"

$SourceDist = Join-Path $SourceDir "dist"
if (-not (Test-Path $SourceDist)) {
    Stop-Install "dist/ directory not found after build"
}

# -- Deploy ---------------------------------------------------------
Write-Step "Deploying to $BinDir..."
New-Item -ItemType Directory -Path $BinDir -Force | Out-Null

if (Test-Path $DistTarget) {
    Remove-Item -Recurse -Force $DistTarget
}
Copy-Item -Recurse -Force $SourceDist $DistTarget
Write-Ok "dist/ copied"

# Workspace packages (@dreamgraph/sdk, @dreamgraph/host) cannot be resolved
# from the registry; pack them into the bin vendor dir and rewrite the deps
# to file: references so `npm install --omit=dev` can complete offline.
$VendorDir = Join-Path $BinDir "vendor"
if (Test-Path $VendorDir) {
    Remove-Item -Recurse -Force $VendorDir
}
New-Item -ItemType Directory -Path $VendorDir -Force | Out-Null

$workspaceTarballs = [ordered]@{}
$workspacePackages = @("@dreamgraph/sdk", "@dreamgraph/host")
foreach ($wsName in $workspacePackages) {
    Write-Host "  Packing $wsName..." -ForegroundColor Cyan
    $packResult = Invoke-LoggedCommand -FilePath "npm" -Arguments @(
        "pack",
        "--workspace", $wsName,
        "--pack-destination", $VendorDir,
        "--loglevel=warn"
    ) -WorkingDirectory $SourceDir -Quiet
    if ($packResult.ExitCode -ne 0) {
        Stop-Install "npm pack $wsName failed (exit code $($packResult.ExitCode))"
    }
    # The tarball name is "<scope>-<name>-<version>.tgz" (scope dash-folded).
    $tarballLine = @($packResult.Output) | Where-Object { $_ -is [string] -and $_ -match "\.tgz$" } | Select-Object -Last 1
    if (-not $tarballLine) {
        # Fallback: scan vendor dir for the most recent tarball matching the pkg name.
        $expected = ($wsName -replace "@", "" -replace "/", "-") + "-*.tgz"
        $tarballLine = (Get-ChildItem -Path $VendorDir -Filter $expected | Sort-Object LastWriteTime -Descending | Select-Object -First 1).Name
    } else {
        $tarballLine = (Split-Path -Leaf ($tarballLine.ToString().Trim()))
    }
    if (-not $tarballLine) {
        Stop-Install "Could not determine tarball name for $wsName"
    }
    $workspaceTarballs[$wsName] = "file:./vendor/$tarballLine"
    Write-Ok "Packed $wsName -> vendor/$tarballLine"
}

$binPkg = [ordered]@{
    name         = "dreamgraph-global"
    version      = $version
    type         = "module"
    dependencies = [ordered]@{}
}
foreach ($dep in $pkg.dependencies.PSObject.Properties) {
    if ($workspaceTarballs.Contains($dep.Name)) {
        $binPkg.dependencies[$dep.Name] = $workspaceTarballs[$dep.Name]
    } else {
        $binPkg.dependencies[$dep.Name] = $dep.Value
    }
}
foreach ($wsName in $workspacePackages) {
    if (-not $binPkg.dependencies.Contains($wsName)) {
        $binPkg.dependencies[$wsName] = $workspaceTarballs[$wsName]
    }
}
if ($pkg.devDependencies -and $pkg.devDependencies.PSObject.Properties.Name -contains "@modelcontextprotocol/sdk") {
    $binPkg.dependencies["@modelcontextprotocol/sdk"] = $pkg.devDependencies."@modelcontextprotocol/sdk"
}
$binPkgJson = $binPkg | ConvertTo-Json -Depth 10
# Use [System.IO.File]::WriteAllText with UTF8 (no BOM); PS5.1 -Encoding UTF8 emits a BOM that breaks JSON.parse in Node.
[System.IO.File]::WriteAllText((Join-Path $BinDir "package.json"), $binPkgJson, (New-Object System.Text.UTF8Encoding $false))
Write-Ok "package.json created"

Write-Host "  Installing dependencies..." -ForegroundColor Cyan
$nodeModulesDir = Join-Path $BinDir "node_modules"
if (Test-Path $nodeModulesDir) {
    Remove-Item -Recurse -Force $nodeModulesDir
}
# Also ensure no stale lockfile is reused — file: deps must be resolved fresh.
$binLockFile = Join-Path $BinDir "package-lock.json"
if (Test-Path $binLockFile) {
    Remove-Item -Force $binLockFile
}
$result = Invoke-LoggedCommand -FilePath "npm" -Arguments @("install", "--omit=dev", "--loglevel=warn") -WorkingDirectory $BinDir
if ($result.ExitCode -ne 0) {
    Stop-Install "npm install failed (exit code $($result.ExitCode))"
}
Write-Ok "Dependencies installed"

# -- Templates -----------------------------------------------------
$sourceTemplates = Join-Path $SourceDir "templates"
if (Test-Path $sourceTemplates) {
    $copyTemplates = $true
    if (Test-Path $TemplateTarget) {
        if ($Force) {
            Remove-Item -Recurse -Force $TemplateTarget
        } else {
            Write-Warn "Existing global templates found at $TemplateTarget"
            $templateConfirm = Read-Host "  Overwrite templates? [y/N]"
            if ($templateConfirm -eq "y" -or $templateConfirm -eq "Y") {
                Remove-Item -Recurse -Force $TemplateTarget
            } else {
                $copyTemplates = $false
                Write-Host "  Keeping existing templates" -ForegroundColor DarkGray
            }
        }
    }

    if ($copyTemplates) {
        Copy-Item -Recurse -Force $sourceTemplates $TemplateTarget
        Write-Ok "Templates copied"
    }
}

# -- VS Code Extension ----------------------------------------------
if (Test-CanBuildVsCodeExtension) {
    Write-Step "Installing VS Code extension..."
    $ExtSourceDir = Join-Path $SourceDir "extensions\vscode"
    $ExtPkgJson  = Join-Path $ExtSourceDir "package.json"
    $CodeCli = Resolve-VsCodeCli

    if (-not (Test-Path $ExtPkgJson)) {
        Write-Warn "Extension source not found at $ExtSourceDir -- skipping"
    } elseif (-not $CodeCli) {
        Write-Warn "VS Code CLI not found (tried PATH and standard install locations) -- skipping extension install"
    } else {
        $extPkg  = Get-Content $ExtPkgJson -Raw | ConvertFrom-Json
        $extensionId = "$($extPkg.publisher).$($extPkg.name)"
        $legacyExtensionVersion = "7"
        $vsixName = "$($extPkg.name)-$($extPkg.version).vsix"
        $vsixPath = Join-Path $ExtSourceDir $vsixName

        Initialize-ExtensionBuildDependencies
        $buildResult = Invoke-LoggedCommand -FilePath "npm" -Arguments @("run", "build") -WorkingDirectory $ExtSourceDir -AllowFailure
        if ($buildResult.ExitCode -ne 0) {
            Write-Warn "Extension build failed -- skipping VS Code extension install"
        } else {
            Write-Ok "Extension built"

            if (Test-Path $vsixPath) {
                Remove-Item -Force $vsixPath
            }

            $packageResult = Invoke-LoggedCommand -FilePath "npx" -Arguments @("--yes", "@vscode/vsce", "package", "--out", $vsixPath) -WorkingDirectory $ExtSourceDir -AllowFailure
            if ($packageResult.ExitCode -ne 0 -or -not (Test-Path $vsixPath)) {
                Write-Warn "Extension packaging failed -- skipping VS Code extension install"
            } else {
                Write-Ok "Packaged extension to $vsixName"
                Remove-LegacyVsCodeExtensionArtifacts -ExtensionId $extensionId -LegacyVersion $legacyExtensionVersion

                $installed = Install-VsCodeExtensionSafely -CodeCli $CodeCli -VsixPath $vsixPath -ExtensionId $extensionId -Version $extPkg.version
                if ($installed) {
                    Write-Ok "Installed $extensionId@$($extPkg.version)"
                    Write-Warn "Reload VS Code (Ctrl+Shift+P > Reload Window) to activate"
                } else {
                    Write-Warn "VS Code extension installation could not be verified; VSIX was built at $vsixPath"
                }
            }
        }
    }
} else {
    Write-Host "  Extension source unavailable -- skipping extension build/install" -ForegroundColor DarkGray
}

# -- Version file ---------------------------------------------------
$versionInfo = [ordered]@{
    version      = $version
    installed_at = (Get-Date -Format o)
    source       = $SourceDir
    node_version = $nodeVersion
} | ConvertTo-Json
# UTF-8 without BOM (Node JSON.parse chokes on the BOM emitted by PS5.1's -Encoding UTF8).
[System.IO.File]::WriteAllText((Join-Path $BinDir "version.json"), $versionInfo, (New-Object System.Text.UTF8Encoding $false))

# -- Create shims --------------------------------------------------
Write-Step "Creating command shims..."
$dgCmd = @"
@echo off
node "%~dp0dist\cli\dg.js" %*
"@
Set-Content -Path (Join-Path $BinDir "dg.cmd") -Value $dgCmd -Encoding ASCII

$serverCmd = @"
@echo off
node "%~dp0dist\index.js" %*
"@
Set-Content -Path (Join-Path $BinDir "dreamgraph.cmd") -Value $serverCmd -Encoding ASCII

$dgPs1 = @'
#!/usr/bin/env pwsh
& node (Join-Path $PSScriptRoot "dist/cli/dg.js") @args
'@
Set-Content -Path (Join-Path $BinDir "dg.ps1") -Value $dgPs1 -Encoding UTF8

$serverPs1 = @'
#!/usr/bin/env pwsh
& node (Join-Path $PSScriptRoot "dist/index.js") @args
'@
Set-Content -Path (Join-Path $BinDir "dreamgraph.ps1") -Value $serverPs1 -Encoding UTF8

Write-Ok "Shims created (dg.cmd, dg.ps1, dreamgraph.cmd, dreamgraph.ps1)"

# -- PATH setup ----------------------------------------------------
Write-Step "Configuring PATH..."
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ([string]::IsNullOrWhiteSpace($userPath)) {
    $userPath = ""
}
if ($userPath -notlike "*$BinDir*") {
    $newUserPath = if ([string]::IsNullOrWhiteSpace($userPath)) { $BinDir } else { "$BinDir;$userPath" }
    [Environment]::SetEnvironmentVariable(
        "Path",
        $newUserPath,
        "User"
    )
    Write-Ok "Added $BinDir to user PATH"
    Write-Warn "Restart your terminal for PATH changes to take effect"
} else {
    Write-Ok "$BinDir already in PATH"
}
$env:Path = if ([string]::IsNullOrWhiteSpace($env:Path)) { $BinDir } else { "$BinDir;$env:Path" }

# -- Verify ---------------------------------------------------------
Write-Step "Verifying installation..."
$verifyResult = Invoke-LoggedCommand -FilePath "node" -Arguments @((Join-Path $DistTarget "cli/dg.js"), "--version") -WorkingDirectory $BinDir -Quiet
Write-Ok "$($verifyResult.Output -join [Environment]::NewLine)"

# -- Summary --------------------------------------------------------
Write-Host ""
Write-Host ("=" * 50) -ForegroundColor Green
Write-Host " DreamGraph v$version installed successfully!" -ForegroundColor Green
Write-Host ("=" * 50) -ForegroundColor Green
Write-Host ""
Write-Host " Binary:   $BinDir" -ForegroundColor White
Write-Host " Run:      dg --help" -ForegroundColor White
Write-Host " Start:    dg start <instance> --http" -ForegroundColor White
Write-Host ""
Write-Host " Reminder: restart any running DreamGraph and VS Code instances to load the updated installation." -ForegroundColor Yellow
Write-Host ""
