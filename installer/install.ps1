<#
.SYNOPSIS
Registers the AHK Hotstring Clipper native host with Chrome for the current user.

.DESCRIPTION
Copies ahk-clipper-host.exe to %LOCALAPPDATA%\AHK Hotstring Clipper, writes the
native messaging host manifest next to it, and points
HKCU\Software\Google\Chrome\NativeMessagingHosts\com.gearoid.ahk_clipper at
that manifest. Needs no administrator rights. Run it again after an update to
replace the exe.

.PARAMETER ExtensionId
The extension ID allowed to start the host. Defaults to extension-id.txt next
to this script.

.PARAMETER InstallDir
Where to put the host. Defaults to %LOCALAPPDATA%\AHK Hotstring Clipper.

.PARAMETER BlockNetwork
Also add a Windows Firewall rule that blocks outbound connections from the
host exe. Needs an administrator PowerShell.

.EXAMPLE
powershell -ExecutionPolicy Bypass -File .\install.ps1
#>
[CmdletBinding()]
param(
    [string]$ExtensionId,
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'AHK Hotstring Clipper'),
    [switch]$BlockNetwork
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$HostName = 'com.gearoid.ahk_clipper'
$ExeName = 'ahk-clipper-host.exe'
$RegistryKey = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName"
$FirewallRule = 'AHK Hotstring Clipper host: block outbound'

$sourceExe = Join-Path $PSScriptRoot "host\$ExeName"
if (-not (Test-Path -LiteralPath $sourceExe)) {
    throw "Can't find $sourceExe. Run this script from the unzipped release folder."
}

if (-not $ExtensionId) {
    $idFile = Join-Path $PSScriptRoot 'extension-id.txt'
    if (-not (Test-Path -LiteralPath $idFile)) {
        throw "Can't find $idFile. Pass -ExtensionId instead."
    }
    $ExtensionId = (Get-Content -LiteralPath $idFile -Raw).Trim()
}
if ($ExtensionId -cnotmatch '^[a-p]{32}$') {
    throw "'$ExtensionId' is not a Chrome extension ID (32 letters from a to p)."
}

if ($BlockNetwork) {
    $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw '-BlockNetwork needs an administrator PowerShell. Run it again elevated, or install without it.'
    }
}

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$exe = Join-Path $InstallDir $ExeName
Copy-Item -LiteralPath $sourceExe -Destination $exe -Force
# Files unzipped from a download carry the "from the internet" mark.
Unblock-File -LiteralPath $exe

$manifestPath = Join-Path $InstallDir "$HostName.json"
$manifest = [ordered]@{
    name            = $HostName
    description     = 'AHK Hotstring Clipper native host'
    path            = $exe
    type            = 'stdio'
    allowed_origins = @("chrome-extension://$ExtensionId/")
}
# Chrome expects UTF-8 without a BOM, which Set-Content -Encoding UTF8 adds in PowerShell 5.1.
[IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json), (New-Object Text.UTF8Encoding $false))

# The key's default value is the manifest path.
New-Item -Path $RegistryKey -Force | Out-Null
Set-Item -Path $RegistryKey -Value $manifestPath

if ($BlockNetwork) {
    Get-NetFirewallRule -DisplayName $FirewallRule -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    New-NetFirewallRule -DisplayName $FirewallRule -Direction Outbound -Program $exe -Action Block | Out-Null
}

Write-Host "Installed the native host for extension $ExtensionId"
Write-Host "  exe:      $exe"
Write-Host "  manifest: $manifestPath"
Write-Host "  registry: $RegistryKey"
if ($BlockNetwork) {
    Write-Host '  firewall: outbound connections from the exe are blocked'
}
Write-Host ''
Write-Host 'Next: in chrome://extensions turn on Developer mode, click Load unpacked and pick the'
Write-Host 'extension folder, then open the extension''s Options page and click Test connection.'
