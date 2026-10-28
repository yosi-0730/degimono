#!/bin/bash
# ========================================
#  在庫管理システム 起動スクリプト (Raspberry Pi OS)
# ========================================

cd "$(dirname "$0")"

echo "========================================"
echo "  在庫管理システム 起動 (Raspberry Pi OS)"
echo "========================================"

if [ -f ".venv/bin/python" ]; then
    echo "仮想環境 .venv の Python を使用して起動します..."
    .venv/bin/python app.py
elif [ -f "venv/bin/python" ]; then
    echo "仮想環境 venv の Python を使用して起動します..."
    venv/bin/python app.py
else
    echo "システムの python3 を使用して起動します..."
    python3 app.py
fi
