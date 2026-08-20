$ErrorActionPreference = 'Stop'

$releaseBase = 'https://github.com/geirfreysson/raynard/releases/latest/download'
$assetName = 'Raynard-windows-x64-setup.exe'
$checksumName = "$assetName.sha256"

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
  throw 'This installer supports Windows. Use install.sh on Linux or the DMG on macOS.'
}

if (-not [Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -eq 'ARM64') {
  throw 'Raynard currently supports x64 Windows only.'
}

$temporaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("raynard-install-" + [guid]::NewGuid())
$installerPath = Join-Path $temporaryRoot $assetName
$checksumPath = Join-Path $temporaryRoot $checksumName
$installDirectory = Join-Path $env:LOCALAPPDATA 'Programs\Raynard'

New-Item -ItemType Directory -Path $temporaryRoot -Force | Out-Null
try {
  Invoke-WebRequest -UseBasicParsing -Uri "$releaseBase/$assetName" -OutFile $installerPath
  Invoke-WebRequest -UseBasicParsing -Uri "$releaseBase/$checksumName" -OutFile $checksumPath

  $expectedChecksum = ((Get-Content -Path $checksumPath -TotalCount 1) -split '\s+')[0].Trim()
  $actualChecksum = (Get-FileHash -Algorithm SHA256 -Path $installerPath).Hash
  if ([string]::IsNullOrWhiteSpace($expectedChecksum) -or
      $actualChecksum -ne $expectedChecksum.ToUpperInvariant()) {
    throw 'Raynard download checksum verification failed.'
  }

  $installer = Start-Process -FilePath $installerPath -ArgumentList @('/S', "/D=$installDirectory") -Wait -PassThru
  if ($installer.ExitCode -ne 0) {
    throw "The Raynard installer exited with code $($installer.ExitCode)."
  }

  $executablePath = Join-Path $installDirectory 'Raynard.exe'
  if (-not (Test-Path -LiteralPath $executablePath)) {
    $executablePath = Get-ChildItem -Path $installDirectory -Filter '*.exe' -File |
      Where-Object { $_.Name -notlike 'uninstall*' } |
      Select-Object -First 1 -ExpandProperty FullName
  }
  if (-not $executablePath -or -not (Test-Path -LiteralPath $executablePath)) {
    throw "Raynard was installed, but its executable was not found under $installDirectory."
  }

  $binDirectory = Join-Path $env:LOCALAPPDATA 'Raynard\bin'
  $launcherPath = Join-Path $binDirectory 'raynard.cmd'
  New-Item -ItemType Directory -Path $binDirectory -Force | Out-Null
  Set-Content -Path $launcherPath -Encoding Ascii -Value "@start `"`" `"$executablePath`" %*"

  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $pathEntries = @($userPath -split ';' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
  if ($pathEntries -notcontains $binDirectory) {
    $newUserPath = (@($pathEntries) + $binDirectory) -join ';'
    [Environment]::SetEnvironmentVariable('Path', $newUserPath, 'User')
  }
  if (($env:Path -split ';') -notcontains $binDirectory) {
    $env:Path = "$env:Path;$binDirectory"
  }

  Write-Host "Raynard was installed at $installDirectory."
  Start-Process -FilePath $executablePath
} catch {
  throw "Raynard could not be installed. Unsigned preview builds may require accepting a Windows SmartScreen warning. $($_.Exception.Message)"
} finally {
  Remove-Item -LiteralPath $temporaryRoot -Recurse -Force -ErrorAction SilentlyContinue
}
