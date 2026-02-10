@echo off
setlocal
chcp 65001 >nul

echo ---------------------------------------------------
echo DIFFsense 開発環境起動スクリプト
echo ---------------------------------------------------
echo.

echo [1/2] バックエンドサーバーを起動しています (Port 3001)...
start "Diffsense Backend" /d "backend" cmd /c "npm run dev"

echo [2/2] フロントエンドサーバーを起動しています (Port 3000)...
echo.
echo ブラウザで http://localhost:3000 を開いてください。
echo.
call npx -y serve . -l 3000

pause
