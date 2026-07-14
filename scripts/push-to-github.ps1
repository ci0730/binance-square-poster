# 将项目推送到 GitHub 私有仓库（首次使用需先登录）
# 用法：在 PowerShell 中执行
#   cd 项目目录
#   .\scripts\push-to-github.ps1

$ErrorActionPreference = "Stop"
$env:Path = "C:\Program Files\Git\bin;C:\Program Files\GitHub CLI;" + $env:Path

# 如直连 GitHub 失败，走本机代理（与软件设置一致）
if (-not $env:HTTPS_PROXY) { $env:HTTPS_PROXY = "http://127.0.0.1:7897" }
if (-not $env:HTTP_PROXY) { $env:HTTP_PROXY = "http://127.0.0.1:7897" }

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$owner = "ci0730"
$repoName = "binance-square-poster"
$remoteUrl = "https://github.com/$owner/$repoName.git"

Write-Host "检查 GitHub 登录状态..." -ForegroundColor Cyan
gh auth status 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host "尚未登录 GitHub CLI，请按提示在浏览器完成授权..." -ForegroundColor Yellow
    Write-Host "打开 https://github.com/login/device 并输入下面的一次性验证码" -ForegroundColor Yellow
    gh auth login -p https -h github.com -w
    gh auth setup-git
}

if (-not (git remote get-url origin 2>$null)) {
    git remote add origin $remoteUrl
} else {
    git remote set-url origin $remoteUrl
}

if (-not (git rev-parse --verify HEAD 2>$null)) {
    throw "本地还没有提交，请先执行 git commit"
}

git branch -M main
Write-Host "正在推送到私有仓库 $owner/$repoName ..." -ForegroundColor Cyan
git push -u origin main

Write-Host ""
Write-Host "完成！私有仓库地址：" -ForegroundColor Green
Write-Host "https://github.com/$owner/$repoName"
