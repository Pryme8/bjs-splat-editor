@echo off
echo ========================================
echo Depth Anything V2 Setup
echo ========================================
echo.

REM Check if Python is installed
python --version > nul 2>&1
if %errorlevel% neq 0 (
    echo ERROR: Python is not installed or not in PATH
    echo Please install Python 3.8+ from https://python.org
    pause
    exit /b 1
)

echo Python found:
python --version

echo.
echo Installing dependencies...
echo This may take a few minutes (downloading PyTorch, etc.)
echo.

pip install -r "%~dp0requirements.txt"

if %errorlevel% neq 0 (
    echo.
    echo ERROR: Failed to install dependencies
    echo Try running: pip install torch torchvision transformers pillow numpy tqdm
    pause
    exit /b 1
)

echo.
echo ========================================
echo Setup complete!
echo ========================================
echo.
echo To test, run:
echo   python "%~dp0depth_anything.py" --help
echo.
echo To enable in the editor:
echo   1. Set DEPTH_ESTIMATION_ENABLED=true in backend/.env
echo   2. Enable "AI Depth Enhancement" in Generator settings
echo.
pause
