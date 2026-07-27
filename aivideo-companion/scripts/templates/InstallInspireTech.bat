@echo off
REM Registers Unity Capture as "InspireTech Camera".
REM Self-elevates via VBS when double-clicked; the desktop app also launches this elevated.

:: BatchGotAdmin (from upstream Unity Capture — no PowerShell)
:-------------------------------------
>nul 2>&1 "%SYSTEMROOT%\system32\cacls.exe" "%SYSTEMROOT%\system32\config\system"
if '%errorlevel%' NEQ '0' (
    echo Requesting administrative privileges...
    goto UACPrompt
) else ( goto gotAdmin )

:UACPrompt
    echo Set UAC = CreateObject^("Shell.Application"^) > "%temp%\inspiretech-getadmin.vbs"
    echo UAC.ShellExecute "cmd.exe", "/c ""%~f0""", "%~dp0", "runas", 1 >> "%temp%\inspiretech-getadmin.vbs"
    "%temp%\inspiretech-getadmin.vbs"
    del "%temp%\inspiretech-getadmin.vbs" 2>nul
    exit /B

:gotAdmin
    pushd "%CD%"
    CD /D "%~dp0"
:-------------------------------------

REM Clear Mark-of-the-Web without PowerShell (Zone.Identifier alternate data stream).
for %%F in ("%~dp0UnityCaptureFilter64.dll" "%~dp0UnityCaptureFilter32.dll") do (
  if exist %%F if exist "%%~fF:Zone.Identifier" del /f /q "%%~fF:Zone.Identifier" 2>nul
)

set "REG64=%SystemRoot%\System32\regsvr32.exe"
set "REG32=%SystemRoot%\SysWOW64\regsvr32.exe"
set "CAPNAME=InspireTech Camera"

REM Unregister stale copies before reinstalling.
if exist "%~dp0UnityCaptureFilter32.dll" if exist "%REG32%" (
  "%REG32%" /s /u "%~dp0UnityCaptureFilter32.dll" >nul 2>&1
)
if exist "%~dp0UnityCaptureFilter64.dll" (
  "%REG64%" /s /u "%~dp0UnityCaptureFilter64.dll" >nul 2>&1
)
timeout /t 1 /nobreak >nul

REM Match upstream Unity Capture InstallCustomName.bat (32-bit first, /i as separate quoted arg).
if exist "%~dp0UnityCaptureFilter32.dll" if exist "%REG32%" (
  "%REG32%" /s "%~dp0UnityCaptureFilter32.dll" "/i:UnityCaptureName=%CAPNAME%"
  if errorlevel 1 exit /b 1
)
if exist "%~dp0UnityCaptureFilter64.dll" (
  "%REG64%" /s "%~dp0UnityCaptureFilter64.dll" "/i:UnityCaptureName=%CAPNAME%"
  if errorlevel 1 exit /b 1
)

exit /b 0
