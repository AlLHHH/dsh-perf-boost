<#
  把本仓库同步到本地 DSH profile 的插件目录，并刷新 node_modules 里那份。

  用法：
    pwsh -File scripts\sync.ps1            # 只同步文件
    pwsh -File scripts\sync.ps1 -Install   # 同步 + pnpm install + doctor

  注意：pnpm 对 file: 依赖常用硬链接；直接 Copy-Item 整个目录会报
  「无法用自身覆盖项」，所以这里是逐文件拷贝到临时名再 Move。
#>
[CmdletBinding()]
param(
  [switch]$Install,
  [string]$Profile = (Join-Path $env:USERPROFILE '.dsh\profiles\desktop')
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$dest = Join-Path $Profile 'plugins\dsh-perf-boost'

function Copy-One([string]$rel) {
  $src = Join-Path $repo $rel
  $dst = Join-Path $dest $rel
  if (-not (Test-Path $src)) { return }
  $dir = Split-Path -Parent $dst
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  $tmp = "$dst.sync-tmp"
  Copy-Item -LiteralPath $src -Destination $tmp -Force
  Move-Item -LiteralPath $tmp -Destination $dst -Force
}

# 宿主侧多一层 lib\host（大会话预热），整目录一起带过去。
$hostFiles = @()
$hostDir = Join-Path $repo 'lib\host'
if (Test-Path $hostDir) {
  $hostFiles = Get-ChildItem -LiteralPath $hostDir -File | ForEach-Object { Join-Path 'lib\host' $_.Name }
}

$files = @('package.json', 'cordis.patch.yml', 'README.md', 'CHANGELOG.md', 'LICENSE', 'lib\index.js', 'lib\client.js')
$files += $hostFiles
foreach ($f in $files) {
  Copy-One $f
}

# node_modules 里那份是运行期真正被加载的
$mod = Join-Path $Profile 'node_modules\dsh-perf-boost'
$runtimeFiles = @('package.json', 'cordis.patch.yml', 'lib\index.js', 'lib\client.js')
$runtimeFiles += $hostFiles
if (Test-Path $mod) {
  foreach ($f in $runtimeFiles) {
    $src = Join-Path $dest $f
    $dst = Join-Path $mod $f
    if (-not (Test-Path $src)) { continue }
    $dir = Split-Path -Parent $dst
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $tmp = "$dst.sync-tmp"
    Copy-Item -LiteralPath $src -Destination $tmp -Force
    Move-Item -LiteralPath $tmp -Destination $dst -Force
  }
  Write-Host "已同步到 $mod"
}

$pkg = Get-Content (Join-Path $dest 'package.json') -Raw | ConvertFrom-Json
Write-Host ("插件目录版本：" + $pkg.version)

if ($Install) {
  Remove-Item Env:CI -ErrorAction SilentlyContinue
  $pnpm = 'D:\DeepSeek\App\resources\runtime\primary-runtime\dependencies\pnpm\bin\pnpm.cjs'
  Push-Location $Profile
  try {
    & D:\nodejs\node.exe $pnpm install
    & D:\nodejs\node.exe 'D:\deep\_tools\_profile_guard.mjs'
  } finally {
    Pop-Location
  }
}

Write-Host '完成。要让改动生效：应用菜单 → 重启应用。'
