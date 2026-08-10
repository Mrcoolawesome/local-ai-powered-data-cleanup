# Builds against the real Zoom Linux Meeting SDK — same build shape as the
# validated spike (spikes/zoom-presentation-bot/zoom-sdk-integration/CMakeLists.txt),
# adapted only for this directory's layout. ZOOM_SDK_DIR must point at the
# extracted SDK; the production Dockerfile sets it to where the SDK gets
# COPYed in at image-build time.
cmake_minimum_required(VERSION 3.16)
project(zoom_bot_service CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

if(NOT DEFINED ZOOM_SDK_DIR)
  set(ZOOM_SDK_DIR "${CMAKE_CURRENT_SOURCE_DIR}/zoom-sdk")
endif()

if(NOT EXISTS "${ZOOM_SDK_DIR}/libmeetingsdk.so")
  message(FATAL_ERROR
    "ZOOM_SDK_DIR (${ZOOM_SDK_DIR}) doesn't contain libmeetingsdk.so. "
    "See docs/07-zoom-bot.md and spikes/zoom-presentation-bot/README.md for "
    "how to obtain the SDK.")
endif()

find_package(Qt6 REQUIRED COMPONENTS Core)

# Same pinning-not-searching reasoning as the spike's CMakeLists.txt — don't
# let find_package(OpenSSL) silently pick up a stray lib from elsewhere on
# CMAKE_PREFIX_PATH.
set(SYSTEM_LIBCRYPTO /usr/lib/x86_64-linux-gnu/libcrypto.so)
set(SYSTEM_LIBSSL /usr/lib/x86_64-linux-gnu/libssl.so)
if(NOT EXISTS "${SYSTEM_LIBCRYPTO}")
  message(FATAL_ERROR "Expected system OpenSSL at ${SYSTEM_LIBCRYPTO} — adjust for this machine's layout.")
endif()

set(BUNDLED_QT6CORE "${ZOOM_SDK_DIR}/qt_libs/Qt/lib/libQt6Core.so.6")
if(NOT EXISTS "${BUNDLED_QT6CORE}")
  message(FATAL_ERROR "Expected the SDK's bundled Qt6Core at ${BUNDLED_QT6CORE}.")
endif()

add_executable(zoom_bot_service src/join_and_share.cpp)

target_include_directories(zoom_bot_service PRIVATE "${ZOOM_SDK_DIR}/h")
get_target_property(QT6CORE_INCLUDE_DIRS Qt6::Core INTERFACE_INCLUDE_DIRECTORIES)
target_include_directories(zoom_bot_service PRIVATE ${QT6CORE_INCLUDE_DIRS})

target_link_libraries(zoom_bot_service PRIVATE
  # NOT Qt6::Core (system) — see the spike's CMakeLists.txt comment for the
  # exact "undefined symbol ... Qt_6_PRIVATE_API" failure this avoids:
  # linking the SDK's own bundled Qt6Core keeps only one Qt6 build loaded
  # in the process, matching what libmeetingsdk.so's bundled Qt6Gui/Qml/
  # Quick/DBus libraries expect.
  "${BUNDLED_QT6CORE}"
  "${SYSTEM_LIBSSL}"
  "${SYSTEM_LIBCRYPTO}"
  "${ZOOM_SDK_DIR}/libmeetingsdk.so"
)

# libmeetingsdk.so is a prebuilt vendor blob whose own internal dependencies
# resolve at load time via its own baked-in RUNPATH, not our link time —
# same reasoning as the spike's CMakeLists.txt.
target_link_options(zoom_bot_service PRIVATE -Wl,--allow-shlib-undefined)

set_target_properties(zoom_bot_service PROPERTIES
  BUILD_RPATH "${ZOOM_SDK_DIR}"
  INSTALL_RPATH "${ZOOM_SDK_DIR}"
)
