@echo off
echo ========================================
echo   在庫管理システム 起動スクリプト (venv)
echo ========================================

if not exist ".venv\Scripts\python.exe" (
    echo [ERROR] 仮想環境 .venv が見つかりません。
    pause
    exit /b 1
)

echo 仮想環境 .venv の Python を使用して起動します...
echo ブラウザで http://localhost:5000 にアクセスしてください。
echo 終了するには Ctrl+C を押してください。
echo.

.\.venv\Scripts\python.exe app.py
pause
