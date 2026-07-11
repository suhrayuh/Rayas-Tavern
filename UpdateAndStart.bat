@echo off
for /F "tokens=1,2 delims=#" %%E in ('"prompt #$E# & echo on & for %%A in (1) do rem"') do set "ESC=%%E"
title Rayas Tavern
pushd %~dp0
git --version > nul 2>&1
if %errorlevel% neq 0 (
    echo [91mGit is not installed on this system.[0m
    echo Install it from https://git-scm.com/downloads
    goto end
) else (
    if not exist .git (
        echo [91mNot running from a Git repository. Reinstall using an officially supported method to get updates.[0m
        echo See: https://docs.sillytavern.app/installation/windows/
        goto end
    )
    call git pull --rebase --autostash
    if %errorlevel% neq 0 (
        REM incase there is still something wrong
        echo [91mThere were errors while updating.[0m
        echo See the update FAQ at https://docs.sillytavern.app/installation/updating/
        goto end
    )
)
set NODE_ENV=production
call npm install --no-save --no-audit --no-fund --loglevel=error --no-progress --omit=dev --ignore-scripts

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
node server.js %*
:end
pause
popd
