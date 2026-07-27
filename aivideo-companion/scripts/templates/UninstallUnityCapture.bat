@echo off
REM Fully removes InspireTech Camera (Unity Capture) registration from all known locations.
REM Args: %1=exitCodeFile (optional)

setlocal EnableExtensions
set "REG64=%SystemRoot%\System32\regsvr32.exe"
set "REG32=%SystemRoot%\SysWOW64\regsvr32.exe"
set "PD=%ProgramData%\InspireTech\UnityCapture"
set "RC=0"

call :UnregisterDir "%PD%"
if defined INSPIRETECH_BUNDLE call :UnregisterDir "%INSPIRETECH_BUNDLE%"

REM Legacy Unity Capture default name registrations.
for %%D in (
  "%PD%\UnityCaptureFilter64.dll"
  "%PD%\UnityCaptureFilter32.dll"
) do if exist %%D call :UnregisterFile %%D

:done
if defined INSPIRETECH_EXITFILE echo %RC%>"%INSPIRETECH_EXITFILE%"
exit /b %RC%

:UnregisterDir
if not exist "%~1\UnityCaptureFilter64.dll" exit /b 0
call :UnregisterFile "%~1\UnityCaptureFilter32.dll"
call :UnregisterFile "%~1\UnityCaptureFilter64.dll"
exit /b 0

:UnregisterFile
if not exist "%~1" exit /b 0
if exist "%REG32%" "%REG32%" /s /u "%~1" >nul 2>&1
"%REG64%" /s /u "%~1" >nul 2>&1
exit /b 0
