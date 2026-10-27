<#
  发版一条龙：改版本 → 自测 → 重建索引 → 提交 → 打 tag →（可选）发 npm →（可选）推 GitHub。

  用法：
    pwsh -File scripts\release.ps1 -Bump patch              # 0.1.0 → 0.1.1，跑检查并提交、打 tag
    pwsh -File scripts\release.ps1 -Bump minor -Publish     # 顺带 npm publish
    pwsh -File scripts\release.ps1 -Bump patch -Push -Publish

  -Bump 省略时沿用 package.json 里的版本（只重新检查/提交）。
#>
[CmdletBinding()]
param(
  [ValidateSet('patch', 'minor', 'major')]
  [string]$Bump,
  [switch]$Publish,
  [switch]$Push,
  [string]$Registry = 'https://registry.npmjs.org'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
  if (git status --porcelain) {
    Write-Host '工作区有未提交改动，先提交或 stash 再发版。' -ForegroundColor Yellow
    git status --short | Out-Host
    throw '工作区不干净'
  }

  if ($Bump) {
    $before = (Get-Content package.json -Raw | ConvertFrom-Json).version
    npm version $Bump --no-git-tag-version --silent | Out-Null
    $after = (Get-Content package.json -Raw | ConvertFrom-Json).version
    Write-Host "版本 $before -> $after"
  }
  $version = (Get-Content package.json -Raw | ConvertFrom-Json).version

  Write-Host '— 语法检查'
  node --check lib/index.js
  node --check lib/client.js

  Write-Host '— 单元测试'
  node --test test/index.test.mjs

  Write-Host '— 重建市场索引'
  node scripts/build-index.mjs
  node scripts/check-index.mjs

  Write-Host '— 打包清单'
  npm pack --dry-run 2>&1 | Select-Object -Last 12 | Out-Host

  Write-Host '— 提交'
  git add -A
  git commit -m "chore: release v$version" | Out-Host
  git tag "v$version"

  if ($Publish) {
    Write-Host "— 发 npm（$Registry）"
    npm publish --registry $Registry
  }

  if ($Push) {
    Write-Host '— 推送'
    git push origin main
    git push --tags
  }

  Write-Host "完成：v$version"
  if (-not $Publish) { Write-Host '（没发 npm：加 -Publish 才会发）' }
  if (-not $Push) { Write-Host '（没推送：加 -Push 才会推）' }
} finally {
  Pop-Location
}
