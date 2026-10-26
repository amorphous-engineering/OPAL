# OPAL installer for Windows — downloads a release binary.
# Usage: irm https://raw.githubusercontent.com/amorphous-engineering/OPAL/master/install.ps1 | iex
#
# Options, as environment variables (piping to iex takes no arguments):
#   $env:OPAL_PRERELEASE = "1"         install the newest release, prereleases included
#   $env:OPAL_VERSION = "v2.0.0-rc.21" install one release
# Or as parameters: & ([scriptblock]::Create((irm <url>))) -Prerelease
# With no option the installer takes the release GitHub marks as Latest.
param(
    [switch]$Prerelease,
    [string]$Version
)
$ErrorActionPreference = "Stop"

$Repo = "amorphous-engineering/OPAL"
$ApiBase = "https://api.github.com/repos/$Repo/releases"
if (-not $Version -and $env:OPAL_VERSION) { $Version = $env:OPAL_VERSION }
if (-not $Prerelease -and $env:OPAL_PRERELEASE -and $env:OPAL_PRERELEASE -ne "0") { $Prerelease = $true }
$InstallDir = Join-Path $env:LOCALAPPDATA "OPAL"
$InstallPath = Join-Path $InstallDir "opal.exe"

# --- Output helpers ---

function Write-Info {
    param([string]$Message)
    Write-Host "info: " -ForegroundColor Green -NoNewline
    Write-Host $Message
}

function Write-Warn {
    param([string]$Message)
    Write-Host "warn: " -ForegroundColor Yellow -NoNewline
    Write-Host $Message
}

function Write-Err {
    param([string]$Message)
    Write-Host "error: " -ForegroundColor Red -NoNewline
    Write-Host $Message
    exit 1
}

# --- Platform detection ---

function Get-Platform {
    $Arch = $env:PROCESSOR_ARCHITECTURE
    switch ($Arch) {
        "AMD64"  { return "x86_64" }
        "x86"    { Write-Err "32-bit Windows is not supported" }
        "ARM64"  { Write-Err "ARM64 Windows is not currently supported" }
        default  { Write-Err "Unsupported architecture: $Arch" }
    }
}

# --- Release lookup ---

function Find-DownloadUrl {
    param([string]$AssetPattern)

    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $Headers = @{ Accept = "application/vnd.github.v3+json" }

    try {
        if ($Version) {
            $Wanted = if ($Version.StartsWith("v")) { $Version } else { "v$Version" }
            Write-Info "Fetching release $Wanted from GitHub..."
            $Release = Invoke-RestMethod -Uri "$ApiBase/tags/$Wanted" -Headers $Headers
        } elseif ($Prerelease) {
            Write-Info "Fetching newest release from GitHub, prereleases included..."
            # The list is newest first and holds no drafts for anonymous callers.
            # Windows PowerShell 5.1 sends a JSON array down a pipe as one object, so assign first.
            $List = Invoke-RestMethod -Uri "${ApiBase}?per_page=10" -Headers $Headers
            $Release = @($List) | Where-Object { -not $_.draft } | Select-Object -First 1
        } else {
            Write-Info "Fetching latest release from GitHub..."
            $Release = Invoke-RestMethod -Uri "$ApiBase/latest" -Headers $Headers
        }
    } catch {
        Write-Err "Failed to fetch release info from GitHub: $_"
    }

    $script:Tag = $Release.tag_name
    if (-not $Tag) {
        Write-Err "Could not determine the release tag"
    }
    Write-Info "Release: $Tag"

    $Asset = $Release.assets | Where-Object { $_.name -like "*$AssetPattern*" } | Select-Object -First 1
    if (-not $Asset) {
        Write-Err "No release asset found matching '$AssetPattern'"
    }

    $Sums = $Release.assets | Where-Object { $_.name -eq "SHA256SUMS" } | Select-Object -First 1
    if (-not $Sums) {
        Write-Err "The release has no SHA256SUMS file"
    }
    $script:SumsUrl = $Sums.browser_download_url

    return $Asset.browser_download_url
}

# --- Checksum ---

function Test-Checksum {
    param([string]$File, [string]$AssetName)

    Write-Info "Verifying SHA-256..."
    try {
        $SumsText = (Invoke-WebRequest -Uri $SumsUrl -UseBasicParsing).Content
        if ($SumsText -is [byte[]]) { $SumsText = [System.Text.Encoding]::UTF8.GetString($SumsText) }
    } catch {
        Remove-Item $File -Force
        Write-Err "Could not download SHA256SUMS: $_"
    }

    $Expected = $null
    foreach ($Line in $SumsText -split "`r?`n") {
        $Parts = $Line.Trim() -split "\s+"
        if ($Parts.Count -ge 2 -and $Parts[1] -eq $AssetName) { $Expected = $Parts[0]; break }
    }
    if (-not $Expected) {
        Remove-Item $File -Force
        Write-Err "SHA256SUMS has no entry for $AssetName"
    }

    $Actual = (Get-FileHash -Path $File -Algorithm SHA256).Hash
    if ($Actual -ne $Expected.ToUpper()) {
        Remove-Item $File -Force
        Write-Err "Checksum mismatch for ${AssetName}: expected $Expected, got $Actual"
    }
}

# --- Install ---

function Install-Binary {
    param([string]$Url, [string]$AssetName)

    Write-Info "Downloading ${AssetName}..."

    if (-not (Test-Path $InstallDir)) {
        New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    }

    $TmpFile = Join-Path $env:TEMP "opal-install-$([System.IO.Path]::GetRandomFileName()).exe"

    try {
        Invoke-WebRequest -Uri $Url -OutFile $TmpFile -UseBasicParsing
    } catch {
        if (Test-Path $TmpFile) { Remove-Item $TmpFile -Force }
        Write-Err "Download failed: $_"
    }

    # Sanity check: file should be at least 1 KB
    $Size = (Get-Item $TmpFile).Length
    if ($Size -lt 1024) {
        Remove-Item $TmpFile -Force
        Write-Err "Downloaded file is too small ($Size bytes) -- something went wrong"
    }

    Test-Checksum -File $TmpFile -AssetName $AssetName

    Move-Item -Path $TmpFile -Destination $InstallPath -Force

    Write-Info "Installed to $InstallPath"
}

# --- PATH check ---

function Update-Path {
    $UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if ($UserPath -and $UserPath.Split(";") -contains $InstallDir) {
        return
    }

    [Environment]::SetEnvironmentVariable("Path", "$InstallDir;$UserPath", "User")
    $env:Path = "$InstallDir;$env:Path"
    Write-Info "Added $InstallDir to your PATH"
    Write-Warn "Restart your terminal for the PATH change to take effect in new sessions"
}

# --- Main ---

function Install-Opal {
    Write-Host ""
    Write-Host "OPAL Installer" -ForegroundColor White
    Write-Host ""

    $Arch = Get-Platform
    Write-Info "Detected platform: windows $Arch"

    $AssetName = "opal-windows-${Arch}.exe"
    $DownloadUrl = Find-DownloadUrl -AssetPattern $AssetName

    Install-Binary -Url $DownloadUrl -AssetName $AssetName
    Update-Path

    Write-Host ""
    Write-Host "OPAL $Tag installed successfully." -ForegroundColor White
    Write-Host "  Run " -NoNewline
    Write-Host "opal" -ForegroundColor Green -NoNewline
    Write-Host " to start."
    Write-Host ""
}

Install-Opal
