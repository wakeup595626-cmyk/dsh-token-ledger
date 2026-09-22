#requires -Version 5.1
<#
  One-click helper for @dsh-external/dsh-token-ledger.

  This file only *locates* an existing DSH profile and then delegates to the
  hardened install.ps1 / uninstall.ps1 sitting next to it. It never creates a
  profile, never edits files on its own, and never touches the ledger data.

  Usage:
    powershell -NoProfile -ExecutionPolicy Bypass -File .\install-auto.ps1 -Action Install
    powershell -NoProfile -ExecutionPolicy Bypass -File .\install-auto.ps1 -Action Uninstall
#>
[CmdletBinding()]
param(
    [ValidateSet('Install', 'Uninstall')][string]$Action = 'Install',
    [string]$DshHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' })
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

if ($PSVersionTable.PSVersion.Major -lt 5) { throw 'This helper requires Windows PowerShell 5.1 or PowerShell 7+.' }
if ($env:OS -ne 'Windows_NT') { throw 'This helper requires Windows.' }

$verb = if ($Action -eq 'Install') { '安装' } else { '卸载' }
$profilesRoot = Join-Path $DshHome 'profiles'
if (-not (Test-Path -LiteralPath $profilesRoot -PathType Container)) {
    throw "找不到 DSH 的 profiles 目录：$profilesRoot`n请先安装并至少启动过一次 DSH；若 DSH 装在别处，可用 -DshHome 指定它的根目录。"
}
$profiles = @(Get-ChildItem -LiteralPath $profilesRoot -Directory | Select-Object -ExpandProperty Name | Sort-Object)
if ($profiles.Count -eq 0) {
    throw "在 $profilesRoot 下没有找到任何 profile。请先启动一次 DSH 让它生成 profile。"
}
if ($profiles.Count -eq 1) {
    $profile = $profiles[0]
} else {
    Write-Host '检测到多个 DSH profile，请选择要操作的一个：'
    for ($i = 0; $i -lt $profiles.Count; $i++) { Write-Host ('  [{0}] {1}' -f ($i + 1), $profiles[$i]) }
    $answer = Read-Host '输入编号后回车'
    $index = 0
    if (-not [int]::TryParse($answer, [ref]$index) -or $index -lt 1 -or $index -gt $profiles.Count) {
        throw "无效的编号：$answer"
    }
    $profile = $profiles[$index - 1]
}

Write-Host ("即将{0}到 profile「{1}」" -f $verb, $profile)
Write-Host ("DSH 根目录：{0}" -f $DshHome)
if ($Action -eq 'Install') { Write-Host '提醒：请先完全退出 DSH，避免和正在运行的实例并发写入 profile。' }
Write-Host ''

if ($Action -eq 'Install') {
    & (Join-Path $PSScriptRoot 'install.ps1') -Profile $profile -DshHome $DshHome
} else {
    & (Join-Path $PSScriptRoot 'uninstall.ps1') -Profile $profile -DshHome $DshHome
}