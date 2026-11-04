<#
.SYNOPSIS
Removes the AHK Hotstring Clipper native host installed by install.ps1.

.DESCRIPTION
Deletes the HKCU registry key, the install folder (the host exe and its
manifest) and, if present, the firewall rule added by install.ps1
-BlockNetwork. Your .ahk files and the extension's settings are not touched.

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
$RegistryKey = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName"
$FirewallRule = 'AHK Hotstring Clipper host: block outbound'

if (Test-Path -Path $RegistryKey) {
    Remove-Item -Path $RegistryKey -Recurse -Force
    Write-Host "Removed $RegistryKey"
}

if (Test-Path -LiteralPath $InstallDir) {
    Remove-Item -LiteralPath $InstallDir -Recurse -Force
    Write-Host "Removed $InstallDir"
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
