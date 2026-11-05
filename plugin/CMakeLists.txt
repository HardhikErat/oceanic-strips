# Indian Oceanic Strips – EuroScope plugin (32-bit DLL, MSVC)
#
#   cmake -S . -B build -A Win32 -DES_SDK_DIR="C:/Program Files (x86)/EuroScope/PlugInEnvironment"
#   cmake --build build --config Release
#
# ES_SDK_DIR must contain EuroScopePlugIn.h and EuroScopePlugInDll.lib from your
# EuroScope installation. The sdk-stub folder is for compile checks only.
cmake_minimum_required(VERSION 3.20)
project(OceanicStrips CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(ES_SDK_DIR "" CACHE PATH "Folder with EuroScopePlugIn.h and EuroScopePlugInDll.lib")

if(NOT CMAKE_SIZEOF_VOID_P EQUAL 4)
  message(FATAL_ERROR "EuroScope is 32-bit: configure with -A Win32")
endif()
if(NOT EXISTS "${ES_SDK_DIR}/EuroScopePlugIn.h")
  message(FATAL_ERROR "Set ES_SDK_DIR to the EuroScope PlugInEnvironment folder")
endif()

add_library(OceanicStrips SHARED
  src/OceanicStrips.cpp
  src/WsClient.cpp
)
target_include_directories(OceanicStrips PRIVATE src)
# SDK header is third-party: treat it as an external header so /W4 stays about our code
target_include_directories(OceanicStrips SYSTEM PRIVATE "${ES_SDK_DIR}")
target_link_libraries(OceanicStrips PRIVATE "${ES_SDK_DIR}/EuroScopePlugInDll.lib" winhttp)
target_compile_definitions(OceanicStrips PRIVATE WIN32_LEAN_AND_MEAN NOMINMAX _CRT_SECURE_NO_WARNINGS UNICODE _UNICODE)
target_compile_options(OceanicStrips PRIVATE /W4 /utf-8 /external:W0)
set_target_properties(OceanicStrips PROPERTIES MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
