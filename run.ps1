#Requires -Version 5.1
<#
  Fridge Specific AI web viewer — finds node.exe even if PATH is wrong.
  Run: .\run.ps1  or double-click run.bat
#>
$ErrorActionPreference = "Stop"
try { chcp 65001 | Out-Null } catch { }
try {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    $OutputEncoding = [System.Text.Encoding]::UTF8
} catch { }
$Root = $PSScriptRoot
Set-Location $Root

function Find-NodeExe {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd -and (Test-Path -LiteralPath $cmd.Source)) {
        return $cmd.Source
    }
    foreach ($p in @(
            "$env:ProgramFiles\nodejs\node.exe",
            "${env:ProgramFiles(x86)}\nodejs\node.exe",
            "$env:LocalAppData\Programs\node\node.exe"
        )) {
        if (Test-Path -LiteralPath $p) { return $p }
    }
    $cursorNode = "$env:LocalAppData\Programs\cursor\resources\app\resources\helpers\node.exe"
    if (Test-Path -LiteralPath $cursorNode) { return $cursorNode }
    return $null
}

function Find-NpmCmd {
    $npm = Get-Command npm -ErrorAction SilentlyContinue
    if ($npm -and (Test-Path -LiteralPath $npm.Source)) { return $npm.Source }
    foreach ($dir in @(
            "$env:ProgramFiles\nodejs",
            "${env:ProgramFiles(x86)}\nodejs",
            "$env:LocalAppData\Programs\node"
        )) {
        $c = Join-Path $dir "npm.cmd"
        if (Test-Path -LiteralPath $c) { return $c }
    }
    return $null
}

function Find-PythonExe {
    $cmd = Get-Command python -ErrorAction SilentlyContinue
    if ($cmd -and (Test-Path -LiteralPath $cmd.Source)) {
        return $cmd.Source
    }
    foreach ($p in @(
            "$env:LocalAppData\Programs\Python\Python312\python.exe",
            "$env:LocalAppData\Programs\Python\Python311\python.exe",
            "$env:LocalAppData\Programs\Python\Python310\python.exe"
        )) {
        if (Test-Path -LiteralPath $p) { return $p }
    }
    return $null
}

$node = Find-NodeExe
if (-not $node) {
    Write-Host ""
    Write-Host "[오류] node.exe 를 찾지 못했습니다." -ForegroundColor Red
    Write-Host "  https://nodejs.org LTS 설치 후, 새 터미널에서 node -v 가 되는지 확인하세요." -ForegroundColor Yellow
    Write-Host ""
    exit 1
}

Write-Host "[info] Node: $node" -ForegroundColor Cyan

$expressDir = Join-Path $Root "node_modules\express"
if (-not (Test-Path -LiteralPath $expressDir)) {
    $npm = Find-NpmCmd
    if (-not $npm) {
        Write-Host "[오류] node_modules 가 없고 npm 도 찾을 수 없습니다. Node LTS 설치 후 이 폴더에서 npm install 을 실행하세요." -ForegroundColor Red
        exit 1
    }
    Write-Host "[info] npm install 실행 중..." -ForegroundColor Cyan
    & $npm install
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[오류] npm install 실패" -ForegroundColor Red
        exit 1
    }
}

$py = Find-PythonExe
if ($py) {
    $env:PYTHON_EXE = $py
    Write-Host "[info] PYTHON_EXE=$py" -ForegroundColor Cyan
} else {
    Remove-Item Env:PYTHON_EXE -ErrorAction SilentlyContinue
    Write-Host "[경고] PATH 에 python 이 없습니다. 파일 상세(/api/file-detail)는 Python 설치 후 동작합니다." -ForegroundColor Yellow
}

$port = if ($env:PORT) { $env:PORT } else { "3000" }
Write-Host ""
Write-Host "  서버 시작 →  http://localhost:$port" -ForegroundColor Green
Write-Host "  (브라우저는 잠시 후 자동으로 열립니다. 팝업/기본 브라우저 설정을 확인하세요.)" -ForegroundColor DarkGray
Write-Host ""

$null = Start-Job -ScriptBlock {
    param($p)
    Start-Sleep -Seconds 2
    Start-Process "http://localhost:$p" -ErrorAction SilentlyContinue
} -ArgumentList $port

try {
    & $node (Join-Path $Root "server.js")
} finally {
    Get-Job | Where-Object { $_.State -eq "Running" } | Stop-Job -ErrorAction SilentlyContinue
    Get-Job | Remove-Job -Force -ErrorAction SilentlyContinue
}
