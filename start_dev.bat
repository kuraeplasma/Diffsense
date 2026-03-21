@echo off
setlocal
chcp 65001 >nul

echo ---------------------------------------------------
echo DIFFsense 開発環境起動スクリプト
echo ---------------------------------------------------
echo.

echo [1/2] バックエンドサーバーを起動しています (Port 3001)...
start "Diffsense Backend" /d "backend" cmd /c "node src/server.js"

echo [2/2] フロントエンドサーバーを起動しています (Port 3000)...
echo.
echo ブラウザで http://localhost:3000 を開いてください。
echo.
where python >nul 2>nul
if %errorlevel%==0 (
    python -m http.server 3000
    goto :EOF
)

where py >nul 2>nul
if %errorlevel%==0 (
    py -m http.server 3000
    goto :EOF
)

where npx >nul 2>nul
if %errorlevel%==0 (
    npx serve . -l 3000
    goto :EOF
)

echo [エラー] Python も npx も見つかりませんでした。
echo Node.js または Python の実行環境を確認してください。

pause
