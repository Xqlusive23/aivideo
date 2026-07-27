@echo off
REM Registers Unity Capture from the app bundle directory (avoids locked ProgramData copies).
REM Args: %1=bundleDir  %2=exitCodeFile
setlocal EnableExtensions

set "BUNDLE=%~1"
set "EXITFILE=%~2"
set "RC=1"

if not defined BUNDLE goto writeExit
if not exist "%BUNDLE%\UnityCaptureFilter64.dll" goto writeExit
if not exist "%BUNDLE%\InstallInspireTech.bat" goto writeExit

cd /D "%BUNDLE%"
call "%BUNDLE%\InstallInspireTech.bat"
set "RC=%ERRORLEVEL%"

REM Best-effort mirror for manual repair (skip locked files silently).
set "PD=%ProgramData%\InspireTech\UnityCapture"
if not exist "%PD%" mkdir "%PD%" 2>nul
copy /Y "%BUNDLE%\InstallInspireTech.bat" "%PD%\InstallInspireTech.bat" >nul 2>&1

:writeExit
if defined EXITFILE echo %RC%>"%EXITFILE%"
exit /b %RC%
