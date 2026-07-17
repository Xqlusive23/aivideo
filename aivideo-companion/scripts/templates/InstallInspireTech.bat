@echo off
REM Registers Unity Capture as "InspireTech Camera" (non-interactive).
REM Must be run elevated — the desktop app launches this via UAC.

CD /D "%~dp0"

REM Remove Mark-of-the-Web (common when files are bundled/extracted).
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "Get-ChildItem -LiteralPath '%~dp0' -Filter 'UnityCaptureFilter*.dll' | Unblock-File -ErrorAction SilentlyContinue" >nul 2>&1

REM 64-bit filter (required on x64 Windows).
regsvr32 /s "%~dp0UnityCaptureFilter64.dll" "/i:UnityCaptureName=InspireTech Camera"
if errorlevel 1 exit /b 1

REM 32-bit filter (optional — use SysWOW64 regsvr32 on 64-bit OS).
if exist "%SystemRoot%\SysWOW64\regsvr32.exe" (
  "%SystemRoot%\SysWOW64\regsvr32.exe" /s "%~dp0UnityCaptureFilter32.dll" "/i:UnityCaptureName=InspireTech Camera"
)

exit /b 0
