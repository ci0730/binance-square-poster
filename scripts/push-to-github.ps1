# 将项目推送到 GitHub 私有仓库（首次使用需先登录）
# 用法：在 PowerShell 中执行
#   cd 项目目录
#   .\scripts\push-to-github.ps1

$ErrorActionPreference = "Stop"
$env:Path = "C:\Program Files\Git\bin;C:\Program Files\GitHub CLI;" + $env:Path

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

Write-Host "检查 GitHub 登录状态..." -ForegroundColor Cyan
$auth = gh auth status 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "尚未登录 GitHub，将打开浏览器进行登录..." -ForegroundColor Yellow
    gh auth login -p https -w
}

$repoName = "binance-square-poster"
Write-Host "创建私有仓库: $repoName" -ForegroundColor Cyan

$existing = gh repo view $repoName 2>$null
if ($LASTEXITCODE -eq 0) {
    Write-Host "仓库已存在，直接推送..." -ForegroundColor Green
    git remote remove origin 2>$null
    $url = gh repo view $repoName --json url -q .url
    git remote add origin "$url.git"
} else {
    gh repo create $repoName --private --source=. --remote=origin --description "币安广场批量发帖工具"
}

git branch -M main
git push -u origin main

Write-Host ""
Write-Host "完成！私有仓库地址：" -ForegroundColor Green
gh repo view $repoName --json url -q .url
