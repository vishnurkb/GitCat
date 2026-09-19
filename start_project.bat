@echo off
REM ===================================================================
REM  start_project.bat  -  GitCat launcher (Windows)
REM
REM  GitCat is a terminal app, not a server: no ports, no browser.
REM  This script checks prerequisites, installs deps on first run,
REM  asks which repo folder to open, and starts GitCat there.
REM  Usage:  start_project.bat                (asks for a folder)
REM          start_project.bat D:\my\repo     (opens that folder)
REM  Once `npm link` has run you can also just type `gitcat` in any folder.
REM ===================================================================

setlocal EnableDelayedExpansion
title GitCat
set "ROOT=%~dp0"

REM ---- prerequisites --------------------------------------------------
for %%B in (node git) do (
    where %%B >nul 2>&1
    if errorlevel 1 (
        echo  [ERROR] "%%B" was not found on your PATH. Install it, open a NEW terminal, try again.
        goto :fail
    )
    echo  [ok] found %%B
)
where gh >nul 2>&1
if errorlevel 1 (echo  [warn] gh not found - GitHub features ^(repos, PRs, accounts^) will not work.) else (echo  [ok] found gh)
where ollama >nul 2>&1
if errorlevel 1 (echo  [warn] ollama not found - GitCat will use Groq only ^(needs GROQ_API_KEY in .env^).) else (echo  [ok] found ollama)
if not exist "%ROOT%.env" echo  [warn] no .env - copy .env.example to .env and add GROQ_API_KEY for the cloud fallback.

REM ---- first run: dependencies ---------------------------------------
if not exist "%ROOT%node_modules" (
    echo  Installing dependencies ^(first run only^)...
    pushd "%ROOT%"
    call npm install
    if errorlevel 1 ( popd & echo  [ERROR] npm install failed - see output above. & goto :fail )
    popd
)

REM ---- which repo? ---------------------------------------------------
set "TARGET=%~1"
if "%TARGET%"=="" (
    echo.
    set /p "TARGET=  Folder to open GitCat in (Enter = current folder %CD%): "
)
if "%TARGET%"=="" set "TARGET=%CD%"
if not exist "%TARGET%\" (
    echo  [ERROR] folder not found: %TARGET%
    goto :fail
)

echo.
echo  Starting GitCat in %TARGET%
echo.
node "%ROOT%bin\gitcat.js" --cwd "%TARGET%"
echo.
echo  GitCat exited.
pause
exit /b 0

:fail
echo.
pause
exit /b 1
