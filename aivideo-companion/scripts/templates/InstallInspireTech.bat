@echo off
REM Registers Unity Capture as "InspireTech Camera" (non-interactive).
REM Must be run elevated — the desktop app launches this via UAC.

CD /D "%~dp0"

REM Remove Mark-of-the-Web (Windows blocks DLLs downloaded/bundled from the internet).
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "Get-ChildItem -LiteralPath '%~dp0' -Filter 'UnityCaptureFilter*.dll' | ForEach-Object { Unblock-File -LiteralPath $_.FullName -ErrorAction SilentlyContinue; $z = ($_.FullName + ':Zone.Identifier'); if (Test-Path -LiteralPath $z) { Remove-Item -LiteralPath $z -Force -ErrorAction SilentlyContinue } }" >nul 2>&1

set "REG64=%SystemRoot%\System32\regsvr32.exe"
set "REG32=%SystemRoot%\SysWOW64\regsvr32.exe"
set "DLL64=%~dp0UnityCaptureFilter64.dll"
set "DLL32=%~dp0UnityCaptureFilter32.dll"
set "NAME=/i:UnityCaptureName=InspireTech Camera"

REM Clear stale registration before reinstalling.
"%REG64%" /s /u "%DLL64%" >nul 2>&1
if exist "%REG32%" if exist "%DLL32%" "%REG32%" /s /u "%DLL32%" >nul 2>&1

REM 64-bit filter (required on x64 Windows).
"%REG64%" /s "%DLL64%" "%NAME%"
if errorlevel 1 exit /b %ERRORLEVEL%

REM 32-bit filter (optional — helps 32-bit calling apps).
if exist "%REG32%" if exist "%DLL32%" (
  "%REG32%" /s "%DLL32%" "%NAME%"
)

exit /b 0
