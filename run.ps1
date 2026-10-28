# 在庫管理システム 起動スクリプト (PowerShell)
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  在庫管理システム 起動スクリプト (venv)" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

$venvPython = ".\.venv\Scripts\python.exe"

if (-not (Test-Path $venvPython)) {
    Write-Host "[ERROR] 仮想環境 .venv が見つかりません。" -ForegroundColor Red
    exit 1
}

Write-Host "仮想環境 .venv の Python を使用して起動します..." -ForegroundColor Green
Write-Host "ブラウザで http://localhost:5000 にアクセスしてください。" -ForegroundColor Yellow
Write-Host "終了するには Ctrl+C を押してください。`n"

& $venvPython app.py
