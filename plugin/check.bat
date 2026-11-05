@echo off
rem Compile-only check of the plugin sources against the API stub (no SDK needed, nothing linked).
cd /d "%~dp0"
call "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars32.bat" >nul || exit /b 1
if not exist build\check mkdir build\check
cl /nologo /c /std:c++17 /EHsc /W4 /utf-8 /DWIN32_LEAN_AND_MEAN /DNOMINMAX /DUNICODE /D_UNICODE /Isdk-stub /Isrc /Fobuild\check\ src\OceanicStrips.cpp src\WsClient.cpp
