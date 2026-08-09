# Placeholder build config — point ZOOM_SDK_DIR at the extracted Linux
# Meeting SDK tarball (see ../README.md) once you have it. Prefer copying
# the actual CMake setup from the SDK's own bundled sample app over
# reworking this by hand; SDK library/header layout varies by version.
cmake_minimum_required(VERSION 3.10)
project(zoom_join_and_share)

set(CMAKE_CXX_STANDARD 14)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

if(NOT DEFINED ZOOM_SDK_DIR)
  message(FATAL_ERROR
    "ZOOM_SDK_DIR is not set. Point it at the extracted Zoom Linux Meeting "
    "SDK directory, e.g.: cmake -DZOOM_SDK_DIR=/path/to/zoom-sdk ..")
endif()

# TODO: once ZOOM_SDK_DIR is real, add:
#   include_directories(${ZOOM_SDK_DIR}/h)
#   link_directories(${ZOOM_SDK_DIR}/qt_libs or /cpp_libs, per the SDK layout)
#   target_link_libraries(zoom_join_and_share <the SDK's .so files>)

add_executable(zoom_join_and_share join_and_share.cpp)
