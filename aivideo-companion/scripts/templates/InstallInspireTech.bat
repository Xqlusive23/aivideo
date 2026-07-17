@echo off
REM Registers Unity Capture as "InspireTech Camera" (non-interactive).
REM Must be run elevated — the desktop app launches this via UAC.

CD /D "%~dp0"
regsvr32 /s "UnityCaptureFilter32.dll" "/i:UnityCaptureName=InspireTech Camera"
if errorlevel 1 exit /b 1
regsvr32 /s "UnityCaptureFilter64.dll" "/i:UnityCaptureName=InspireTech Camera"
if errorlevel 1 exit /b 1
exit /b 0
