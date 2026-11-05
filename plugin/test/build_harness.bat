@echo off
cd /d "%~dp0.."
call "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars32.bat" >nul 2>&1 || exit /b 1
if not exist build\harness mkdir build\harness
cl /nologo /std:c++17 /EHsc /W4 /utf-8 /DWIN32_LEAN_AND_MEAN /DNOMINMAX /Isrc /Fobuild\harness\ /Febuild\harness\ws_harness.exe test\ws_harness.cpp src\WsClient.cpp winhttp.lib
