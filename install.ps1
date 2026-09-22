#requires -Version 5.1
<#!
Installs into one explicitly named, existing DSH profile. No DSH process is started.
DshHome selects configuration only; it does not change the runtime environment.
Action is also used by uninstall.ps1 so both operations share safety checks.
!#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidatePattern('^[A-Za-z0-9][A-Za-z0-9_.-]*$')][string]$Profile,
    [string]$DshHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }),
    [ValidateSet('Install', 'Uninstall')][string]$Action = 'Install'
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
if ($env:OS -ne 'Windows_NT') { throw 'This script requires Windows junction support.' }
$utf8 = New-Object System.Text.UTF8Encoding($false)
function Full-Path([string]$Path) {
    return [IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
}
function Read-Object([string]$Path) {
    $value = [IO.File]::ReadAllText($Path, $utf8) | ConvertFrom-Json
    if ($null -eq $value -or $value -isnot [pscustomobject]) { throw "Expected JSON object: $Path" }
    return $value
}
function Property($Object, [string]$Name) {
    $p = $Object.PSObject.Properties[$Name]
    if ($null -ne $p) { return ,$p.Value }
    return $null
}
function Object-Property($Object, [string]$Name) {
    $value = Property $Object $Name
    if ($null -eq $value) {
        $value = [pscustomobject]@{}
        $Object | Add-Member -NotePropertyName $Name -NotePropertyValue $value -Force
    }
    if ($value -isnot [pscustomobject]) { throw "Expected object property: $Name" }
    return $value
}
function Assert-PlainAncestors([string]$Path) {
    $cursor = $Path
    while ($cursor) {
        $item = Get-Item -LiteralPath $cursor -Force -ErrorAction SilentlyContinue
        if ($null -ne $item -and (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
            throw "Refusing reparse-point ancestor: $cursor"
        }
        $parent = Split-Path -Parent $cursor
        if ($parent -eq $cursor) { break }
        $cursor = $parent
    }
}
$pkgDir = Full-Path $PSScriptRoot
$homeDir = Full-Path $DshHome
$profileDir = Join-Path (Join-Path $homeDir 'profiles') $Profile
Assert-PlainAncestors $profileDir
if (-not (Test-Path -LiteralPath $profileDir -PathType Container)) { throw "Profile does not exist: $profileDir (no fallback profile is selected)." }
$pkg = Read-Object (Join-Path $pkgDir 'package.json')
$pkgName = Property $pkg 'name'
if ($pkgName -ne '@dsh-external/dsh-token-ledger') { throw 'Unexpected plugin package name.' }
if ($Action -eq 'Install') {
    foreach ($file in @('lib\index.js', 'lib\client.js')) {
        if (-not (Test-Path -LiteralPath (Join-Path $pkgDir $file) -PathType Leaf)) { throw "Missing distributed artifact: $file" }
    }
}
$jsonPath = Join-Path $profileDir 'package.json'
Assert-PlainAncestors $jsonPath
$config = Read-Object $jsonPath
$original = [IO.File]::ReadAllBytes($jsonPath)
$dependencies = Object-Property $config 'dependencies'
$dsh = Object-Property $config 'dsh'
$profileConfig = Object-Property $dsh 'profile'
$rawBundles = Property $profileConfig 'bundles'
if ($null -ne $rawBundles -and $rawBundles -isnot [array]) { throw 'dsh.profile.bundles must be an array.' }
$bundles = @($rawBundles | Where-Object { $null -ne $_ })
foreach ($bundle in $bundles) { if ($bundle -isnot [string]) { throw 'Bundle names must be strings.' } }
# Absolute link paths support different drives and Windows PowerShell 5.1.
$link = 'link:' + ($pkgDir -replace '\\', '/')
$oldDependency = Property $dependencies $pkgName
if ($null -ne $oldDependency -and $oldDependency -ne $link) {
    $matching = $false
    if ($oldDependency -is [string] -and $oldDependency.StartsWith('link:')) {
        $target = $oldDependency.Substring(5)
        if (-not [IO.Path]::IsPathRooted($target)) { $target = Join-Path $profileDir $target }
        $matching = (Full-Path $target) -eq $pkgDir
    }
    if (-not $matching) { throw 'Conflicting dependency: refusing to overwrite/remove another installation.' }
}
$scopeDir = Join-Path $profileDir 'node_modules\@dsh-external'
$junction = Join-Path $scopeDir 'dsh-token-ledger'
Assert-PlainAncestors $scopeDir
function Get-OwnedJunction {
    $item = Get-Item -LiteralPath $junction -Force -ErrorAction SilentlyContinue
    if ($null -eq $item) { return $null }
    if ($item.LinkType -ne 'Junction' -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) {
        throw "Refusing to remove a real directory/file or non-junction: $junction"
    }
    $targets = @($item.Target)
    if ($targets.Count -ne 1 -or (Full-Path $targets[0]) -ne $pkgDir) { throw "Junction belongs to a different target: $junction" }
    return $item
}
$existing = Get-OwnedJunction
$count = @($bundles | Where-Object { $_ -eq $pkgName }).Count
if ($Action -eq 'Install') {
    $jsonChanged = ($oldDependency -ne $link -or $count -ne 1)
    $dependencies | Add-Member -NotePropertyName $pkgName -NotePropertyValue $link -Force
    $newBundles = @($bundles | Where-Object { $_ -ne $pkgName }) + @($pkgName)
    $linkChanged = $null -eq $existing
} else {
    $jsonChanged = ($null -ne $dependencies.PSObject.Properties[$pkgName] -or $count -gt 0)
    $dependencies.PSObject.Properties.Remove($pkgName)
    $newBundles = @($bundles | Where-Object { $_ -ne $pkgName })
    $linkChanged = $null -ne $existing
}
$profileConfig | Add-Member -NotePropertyName bundles -NotePropertyValue @($newBundles) -Force
if (-not $jsonChanged -and -not $linkChanged) { Write-Host "$Action already satisfied: $profileDir"; return }
$newJson = $config | ConvertTo-Json -Depth 100 -WarningAction Stop
# Backups are retained on success and failure; they may contain private profile metadata.
$backupDir = Join-Path $profileDir ('.token-ledger-backups\' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N'))
Assert-PlainAncestors (Split-Path -Parent $backupDir)
New-Item -ItemType Directory -Path $backupDir | Out-Null
[IO.File]::WriteAllBytes((Join-Path $backupDir 'package.json'), $original)
$manifest = [ordered]@{ action = $Action; profile = $profileDir; junction = $junction; existed = ($null -ne $existing); target = $pkgDir }
[IO.File]::WriteAllText((Join-Path $backupDir 'junction.json'), ($manifest | ConvertTo-Json), $utf8)
Write-Host "Backup: $backupDir"
$tempPath = Join-Path $profileDir ('.token-ledger-' + [guid]::NewGuid().ToString('N') + '.tmp')
$createdDirs = New-Object 'System.Collections.Generic.List[string]'
$linkMutated = $false
try {
    if ($jsonChanged) { [IO.File]::WriteAllText($tempPath, $newJson + [Environment]::NewLine, $utf8) }
    if ($linkChanged) {
        if ($Action -eq 'Install') {
            foreach ($dir in @((Join-Path $profileDir 'node_modules'), $scopeDir)) {
                if (-not (Test-Path -LiteralPath $dir)) {
                    New-Item -ItemType Directory -Path $dir | Out-Null
                    $createdDirs.Add($dir)
                }
            }
            New-Item -ItemType Junction -Path $junction -Target $pkgDir | Out-Null
            $linkMutated = $true
            $null = Get-OwnedJunction
        } else {
            $null = Get-OwnedJunction
            # Directory.Delete without recursion removes only the verified junction.
            [IO.Directory]::Delete($junction)
            $linkMutated = $true
        }
    }
    # Atomic file replacement is the last transaction step. PowerShell 5.1/.NET requires
    # a concrete backup path (null causes "path is not of a legal form").
    if ($jsonChanged) { [IO.File]::Replace($tempPath, $jsonPath, (Join-Path $backupDir 'package.json.replace-backup')) }
} catch {
    $failure = $_
    try {
        if ($linkMutated) {
            if ($Action -eq 'Install') {
                $null = Get-OwnedJunction
                [IO.Directory]::Delete($junction)
            } else {
                New-Item -ItemType Junction -Path $junction -Target $pkgDir | Out-Null
            }
        }
        for ($i = $createdDirs.Count - 1; $i -ge 0; $i--) { [IO.Directory]::Delete($createdDirs[$i]) }
    } catch {
        throw "Operation failed: $failure. ROLLBACK INCOMPLETE: $_. Restore from $backupDir with DSH stopped."
    }
    throw "Operation failed; junction changes rolled back, original JSON retained. $failure Backup: $backupDir"
} finally {
    if ([IO.File]::Exists($tempPath)) { [IO.File]::Delete($tempPath) }
}
Write-Host "$Action complete for $profileDir. Ledger and sessions were not modified."
Write-Host 'Restart DSH using its normal launcher, then verify the plugin. This is not a runtime/cold-start test.'
