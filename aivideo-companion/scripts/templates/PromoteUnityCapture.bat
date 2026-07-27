@echo off
REM Copies staged driver files into ProgramData and registers the virtual camera.
REM Args: %1=pendingDir  %2=stageDir  %3=exitCodeFile
setlocal EnableExtensions

set "PENDING=%~1"
set "STAGE=%~2"
set "EXITFILE=%~3"

if not defined PENDING exit /b 1
if not defined STAGE exit /b 1

if not exist "%STAGE%" mkdir "%STAGE%"

set "REG64=%SystemRoot%\System32\regsvr32.exe"
set "REG32=%SystemRoot%\SysWOW64\regsvr32.exe"

if exist "%STAGE%\UnityCaptureFilter32.dll" if exist "%REG32%" (
  "%REG32%" /s /u "%STAGE%\UnityCaptureFilter32.dll" >nul 2>&1
)
if exist "%STAGE%\UnityCaptureFilter64.dll" (
  "%REG64%" /s /u "%STAGE%\UnityCaptureFilter64.dll" >nul 2>&1
)
timeout /t 1 /nobreak >nul

xcopy /Y /Q "%PENDING%\*" "%STAGE%\" >nul
if errorlevel 1 (
  set "RC=1"
  goto writeExit
)

for %%F in ("%STAGE%\UnityCaptureFilter64.dll" "%STAGE%\UnityCaptureFilter32.dll") do (
  if exist %%F if exist "%%~fF:Zone.Identifier" del /f /q "%%~fF:Zone.Identifier" 2>nul
)

cd /D "%STAGE%"
call "%STAGE%\InstallInspireTech.bat"
set "RC=%ERRORLEVEL%"

:writeExit
if defined EXITFILE echo %RC%>"%EXITFILE%"
exit /b %RC%
