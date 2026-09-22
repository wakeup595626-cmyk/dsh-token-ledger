#requires -Version 5.1
# Removes this package's profile registration and verified junction only.
# Keep install.ps1 beside this file: both operations share its transaction engine.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidatePattern('^[A-Za-z0-9][A-Za-z0-9_.-]*$')][string]$Profile,
    [string]$DshHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' })
)
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'install.ps1') -Profile $Profile -DshHome $DshHome -Action Uninstall
