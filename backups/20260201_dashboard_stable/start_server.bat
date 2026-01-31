@echo off
setlocal
chcp 65001 >nul

echo ---------------------------------------------------
echo ローカルWebサーバー起動スクリプト
echo ---------------------------------------------------
echo.

REM Check for npx (Node.js)
where npx >nul 2>nul
if %errorlevel%==0 (
    echo [OK] Node.js が見つかりました。サーバーを起動します...
    echo ブラウザで http://localhost:3000 を開いてください。
    echo.
    call npx -y serve .
    goto :EOF
)

REM Check for Python
where python >nul 2>nul
if %errorlevel%==0 (
    echo [OK] Python が見つかりました。サーバーを起動します...
    echo ブラウザで http://localhost:8000 を開いてください。
    echo.
    python -m http.server 8000
    goto :EOF
)

REM If neither found
echo [エラー] Node.js も Python も見つかりませんでした。
echo.
echo Firebase認証を動かすには、ローカルサーバーが必要です。
echo 以下のいずれかをインストールしてください：
echo.
echo 1. Node.js (推奨) - https://nodejs.org/
echo    インストール後、このスクリプトを再度実行してください。
echo.
pause
