@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo აპლიკაცია იხსნება...
if not exist "node_modules" (
    echo დამოკიდებულებების დაყენება...
    call npm install
)
npm start
pause

