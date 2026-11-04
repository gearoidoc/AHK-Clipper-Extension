<#
.SYNOPSIS
Removes the AHK Hotstring Clipper native host installed by install.ps1.

.DESCRIPTION
Deletes the HKCU registry key, the host exe and its manifest, and, if
present, the firewall rule added by install.ps1 -BlockNetwork. The install
folder goes too, but only once nothing else is left in it, so pointing
-InstallDir at a shared folder never deletes anything else. Your .ahk files
and the extension's settings are not touched.

.PARAMETER InstallDir
The folder install.ps1 used. Defaults to %LOCALAPPDATA%\AHK Hotstring Clipper.

.EXAMPLE
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1
#>
[CmdletBinding()]
param(
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'AHK Hotstring Clipper')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$HostName = 'com.gearoid.ahk_clipper'
$ExeName = 'ahk-clipper-host.exe'
$RegistryKey = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName"
$FirewallRule = 'AHK Hotstring Clipper host: block outbound'

if (Test-Path -Path $RegistryKey) {
    Remove-Item -Path $RegistryKey -Recurse -Force
    Write-Host "Removed $RegistryKey"
}

if (Test-Path -LiteralPath $InstallDir) {
    # Only the files install.ps1 put there.
    foreach ($name in @($ExeName, "$HostName.json")) {
        $file = Join-Path $InstallDir $name
        if (Test-Path -LiteralPath $file) {
            Remove-Item -LiteralPath $file -Force
            Write-Host "Removed $file"
        }
    }
    if (-not (Get-ChildItem -LiteralPath $InstallDir -Force | Select-Object -First 1)) {
        Remove-Item -LiteralPath $InstallDir -Force
        Write-Host "Removed $InstallDir"
    } else {
        Write-Host "Left $InstallDir in place because it holds other files"
    }
}

$rule = Get-NetFirewallRule -DisplayName $FirewallRule -ErrorAction SilentlyContinue
if ($rule) {
    try {
        $rule | Remove-NetFirewallRule
        Write-Host "Removed firewall rule '$FirewallRule'"
    } catch {
        Write-Warning "Removing the firewall rule '$FirewallRule' needs an administrator PowerShell."
    }
}

Write-Host 'The native host is uninstalled. Remove the extension itself in chrome://extensions.'
