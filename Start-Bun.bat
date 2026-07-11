@echo off
for /F "tokens=1,2 delims=#" %%E in ('"prompt #$E# & echo on & for %%A in (1) do rem"') do set "ESC=%%E"
setlocal enabledelayedexpansion
pushd %~dp0
title Rayas Tavern

set "PATH=%USERPROFILE%\.bun\bin;%PATH%"

where bun > nul 2>&1
if %errorlevel% neq 0 (
    echo Bun was not found. Attempting to install Bun automatically...
    where powershell > nul 2>&1
    if !errorlevel! neq 0 (
        echo.
        echo ============================================================
        echo  Bun could not be found, and PowerShell is unavailable.
        echo  Please install Bun manually from https://bun.sh/
        echo ============================================================
        echo.
        goto end
    )

    echo Installing Bun via PowerShell...
    powershell -NoProfile -ExecutionPolicy Bypass -Command "irm bun.sh/install.ps1 | iex"
    if !errorlevel! neq 0 (
        echo.
        echo ============================================================
        echo  Bun installation failed.
        echo  Please install Bun manually from https://bun.sh/
        echo ============================================================
        echo.
        goto end
    )

    REM Refresh PATH after install
    set "PATH=%USERPROFILE%\.bun\bin;%PATH%"

    where bun > nul 2>&1
    if !errorlevel! neq 0 (
        echo.
        echo ============================================================
        echo  Bun was installed but could not be found in PATH.
        echo  Please restart this terminal and try again.
        echo ============================================================
        echo.
        goto end
    )

    echo Bun installed successfully.
    echo.
)

echo Installing dependencies with Bun...
set NODE_ENV=production
call bun install
if %errorlevel% neq 0 goto end

echo.
echo %ESC%[1;38;2;212;171;212m~ * ~ * ~ * ~ * ~ * ~ * ~ * ~ * ~ * ~ * ~ * ~ * ~ * ~ * ~ * ~ * ~ * ~ * ~ * ~ * ~ *%ESC%[0m
echo.
echo %ESC%[1;38;2;241;77;166m______  _____   _____   _____   _____ ___  _   _ ___________ _   _ %ESC%[0m
echo %ESC%[1;38;2;235;96;175m^| ___ \/ _ \ \ / / _ \ /  ___^| ^|_   _/ _ \^| ^| ^| ^|  ___^| ___ \ \ ^| ^|%ESC%[0m
echo %ESC%[1;38;2;229;115;184m^| ^|_/ / /_\ \ V / /_\ \\ `--.    ^| ^|/ /_\ \ ^| ^| ^| ^|__ ^| ^|_/ /  \^| ^|%ESC%[0m
echo %ESC%[1;38;2;223;134;193m^|    /^|  _  ^|\ /^|  _  ^| `--. \   ^| ^|^|  _  ^| ^| ^| ^|  __^|^|    /^| . ` ^|%ESC%[0m
echo %ESC%[1;38;2;217;153;202m^| ^|\ \^| ^| ^| ^|^| ^|^| ^| ^| ^|/\__/ /   ^| ^|^| ^| ^| \ \_/ / ^|___^| ^|\ \^| ^|\  ^|%ESC%[0m
echo %ESC%[1;38;2;212;171;212m\_^| \_\_^| ^|_/\_/\_^| ^|_/\____/    \_/\_^| ^|_/\___/\____/\_^| \_\_^| \_/%ESC%[0m
echo.
echo %ESC%[38;2;212;171;212m   a SillyTavern fork, made with love%ESC%[0m
echo.
echo %ESC%[1;38;2;212;171;212m~ * ~ * ~ * ~ * ~ * ~ * ~ * ~ * ~ * ~ * ~ * ~ * ~ * ~ * ~ * ~ * ~ * ~ * ~ * ~ * ~ *%ESC%[0m
echo.
echo   Starting server...
echo   - First launch: legacy chats are migrated to the
echo     SQLite database automatically (logs below).
echo   - Later launches: migration is skipped (database ready).
echo.
bun server.js %*

:end
pause
popd
endlocal
