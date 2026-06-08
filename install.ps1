param(
    [string]$Repo = $env:LLAMA_NODRAMA_REPO,
    [string]$Version = $env:LLAMA_NODRAMA_VERSION,
    [string]$InstallDir = $env:LLAMA_NODRAMA_INSTALL_DIR,
    [switch]$NoPathUpdate
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($Repo)) {
    $Repo = "hangry-labs/llama.nodrama"
}
if ([string]::IsNullOrWhiteSpace($Version)) {
    $Version = "latest"
}
if ([string]::IsNullOrWhiteSpace($InstallDir)) {
    $InstallDir = Join-Path $HOME "bin"
}

function Resolve-Arch {
    try {
        $arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
    } catch {
        $arch = $env:PROCESSOR_ARCHITECTURE
    }

    switch ($arch.ToLowerInvariant()) {
        "x64" { "amd64"; return }
        "amd64" { "amd64"; return }
        "arm64" { "arm64"; return }
        default { throw "Unsupported architecture: $arch" }
    }
}

function Download-File {
    param(
        [string]$Url,
        [string]$OutputPath
    )
    Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $OutputPath
}

function Normalize-PathEntry {
    param([string]$PathEntry)
    if ([string]::IsNullOrWhiteSpace($PathEntry)) {
        return ""
    }
    return $PathEntry.Trim().Trim('"').TrimEnd("\")
}

function Test-PathContains {
    param(
        [string]$PathValue,
        [string]$Directory
    )
    $Needle = Normalize-PathEntry $Directory
    if ([string]::IsNullOrWhiteSpace($Needle)) {
        return $true
    }
    foreach ($Part in ($PathValue -split ";")) {
        if ((Normalize-PathEntry $Part).Equals($Needle, [StringComparison]::OrdinalIgnoreCase)) {
            return $true
        }
    }
    return $false
}

function Add-UserPath {
    param([string]$Directory)

    if ($NoPathUpdate) {
        Write-Host "PATH update skipped because -NoPathUpdate was specified."
        return
    }

    $NormalizedDir = Normalize-PathEntry $Directory
    if ([string]::IsNullOrWhiteSpace($NormalizedDir)) {
        return
    }

    $UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if ([string]::IsNullOrWhiteSpace($UserPath)) {
        $NewUserPath = $NormalizedDir
    } elseif (Test-PathContains -PathValue $UserPath -Directory $NormalizedDir) {
        $NewUserPath = $UserPath
    } else {
        $NewUserPath = $UserPath.TrimEnd(";") + ";" + $NormalizedDir
    }

    if ($NewUserPath -ne $UserPath) {
        [Environment]::SetEnvironmentVariable("Path", $NewUserPath, "User")
        Write-Host "Added to user PATH: $NormalizedDir"
    } else {
        Write-Host "User PATH already includes: $NormalizedDir"
    }

    if (-not (Test-PathContains -PathValue $env:Path -Directory $NormalizedDir)) {
        $env:Path = $env:Path.TrimEnd(";") + ";" + $NormalizedDir
        Write-Host "Updated PATH for this PowerShell session."
    }
}

$Arch = Resolve-Arch
$Asset = "llama-nodrama-windows-$Arch.zip"
$Binary = "llama-nodrama.exe"

if ($Version -eq "latest") {
    $BaseUrl = "https://github.com/$Repo/releases/latest/download"
} else {
    $BaseUrl = "https://github.com/$Repo/releases/download/$Version"
}

$TempDir = Join-Path ([IO.Path]::GetTempPath()) ("llama-nodrama-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $TempDir | Out-Null

try {
    $ArchivePath = Join-Path $TempDir $Asset
    $SumsPath = Join-Path $TempDir "SHA256SUMS"
    $ExtractDir = Join-Path $TempDir "extract"

    Write-Host "Downloading $Repo $Version windows/$Arch..."
    Download-File -Url "$BaseUrl/$Asset" -OutputPath $ArchivePath

    try {
        Download-File -Url "$BaseUrl/SHA256SUMS" -OutputPath $SumsPath
        $ExpectedLine = Get-Content $SumsPath | Where-Object { $_ -match "\s+$([regex]::Escape($Asset))$" } | Select-Object -First 1
        if ($ExpectedLine) {
            $Expected = ($ExpectedLine -split "\s+")[0].ToLowerInvariant()
            $Actual = (Get-FileHash -Algorithm SHA256 $ArchivePath).Hash.ToLowerInvariant()
            if ($Expected -ne $Actual) {
                throw "Checksum mismatch for $Asset"
            }
        }
    } catch {
        if ($_.Exception.Message -like "Checksum mismatch*") {
            throw
        }
        Write-Warning "Could not verify checksum: $($_.Exception.Message)"
    }

    New-Item -ItemType Directory -Force -Path $ExtractDir | Out-Null
    Expand-Archive -Force -Path $ArchivePath -DestinationPath $ExtractDir

    $Source = Join-Path $ExtractDir $Binary
    if (-not (Test-Path $Source)) {
        throw "Release archive did not contain $Binary"
    }

    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    $Target = Join-Path $InstallDir "llama-nodrama.exe"
    Copy-Item -Force -Path $Source -Destination $Target

    Write-Host "Installed: $Target"
    Add-UserPath -Directory $InstallDir
    Write-Host "Run: llama-nodrama --help"
} finally {
    Remove-Item -Recurse -Force -Path $TempDir -ErrorAction SilentlyContinue
}
