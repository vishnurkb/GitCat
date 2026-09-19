@echo off
REM  check_docs.bat  -  is the documentation still true?
REM
REM    check_docs.bat           report drift
REM    check_docs.bat --write   also regenerate the tree in docs/structure.md
REM
REM  Wrapper around check_docs.py so it is one double-click on Windows.

setlocal
where python >nul 2>&1
if errorlevel 1 (
    echo  [ERROR] python not on PATH. Install it, or run check_docs.py directly.
    pause
    exit /b 1
)
python "%~dp0check_docs.py" %*
echo.
pause
endlocal
