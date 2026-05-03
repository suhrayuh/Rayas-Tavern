@echo off
setlocal enabledelayedexpansion
pushd %~dp0

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
echo Starting RayasTavern with Bun...
bun server.js %*

:end
pause
popd
endlocal
