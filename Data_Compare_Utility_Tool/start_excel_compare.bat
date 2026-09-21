@echo off
REM Start the Data Compare Utility on http://127.0.0.1:8000
setlocal
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
    echo Creating the virtual environment...
    python -m venv .venv || goto :error
    ".venv\Scripts\python.exe" -m pip install --upgrade pip
    ".venv\Scripts\python.exe" -m pip install -r requirements.txt || goto :error
)

start "" http://127.0.0.1:8000
".venv\Scripts\python.exe" main.py
goto :eof

:error
echo.
echo Startup failed. Make sure Python 3.10 or newer is installed and on PATH.
pause
