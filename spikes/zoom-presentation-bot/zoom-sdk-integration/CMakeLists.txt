# Builds against the real Zoom Linux Meeting SDK. ZOOM_SDK_DIR must point at
# the extracted SDK (../zoom-sdk here, once you've dropped the tarball in —
# see ../README.md). The RUNPATH baked into libmeetingsdk.so itself
# ($ORIGIN/qt_libs/Qt/lib) resolves its bundled Qt6 at load time, so we only
# need Qt6Core here for our own QCoreApplication event loop, not the rest of
# the bundled Qt runtime.
cmake_minimum_required(VERSION 3.16)
project(zoom_join_and_share CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

if(NOT DEFINED ZOOM_SDK_DIR)
  set(ZOOM_SDK_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../zoom-sdk")
endif()

if(NOT EXISTS "${ZOOM_SDK_DIR}/libmeetingsdk.so")
  message(FATAL_ERROR
    "ZOOM_SDK_DIR (${ZOOM_SDK_DIR}) doesn't contain libmeetingsdk.so. "
    "Extract the SDK tarball there first — see ../README.md.")
endif()

# Only used for headers (QCoreApplication/QDebug/QTimer are ABI-stable
# enough across Qt6 minor versions to compile against). We deliberately do
# NOT link Qt6::Core (the system Qt6, 6.10.2 here) — see below.
find_package(Qt6 REQUIRED COMPONENTS Core)

# find_package(OpenSSL) picks up whichever libcrypto.a/.so it finds first on
# CMAKE_PREFIX_PATH / the module search path — on a dev machine with other
# projects' build trees lying around, that can silently be a stray static
# lib from an unrelated project instead of the system OpenSSL. Pin to the
# actual system libssl-dev paths explicitly rather than trust the search.
set(SYSTEM_LIBCRYPTO /usr/lib/x86_64-linux-gnu/libcrypto.so)
set(SYSTEM_LIBSSL /usr/lib/x86_64-linux-gnu/libssl.so)
if(NOT EXISTS "${SYSTEM_LIBCRYPTO}")
  message(FATAL_ERROR "Expected system OpenSSL at ${SYSTEM_LIBCRYPTO} — adjust for this machine's layout.")
endif()

set(BUNDLED_QT6CORE "${ZOOM_SDK_DIR}/qt_libs/Qt/lib/libQt6Core.so.6")
if(NOT EXISTS "${BUNDLED_QT6CORE}")
  message(FATAL_ERROR "Expected the SDK's bundled Qt6Core at ${BUNDLED_QT6CORE}.")
endif()

add_executable(zoom_join_and_share join_and_share.cpp)

target_include_directories(zoom_join_and_share PRIVATE "${ZOOM_SDK_DIR}/h")
get_target_property(QT6CORE_INCLUDE_DIRS Qt6::Core INTERFACE_INCLUDE_DIRECTORIES)
target_include_directories(zoom_join_and_share PRIVATE ${QT6CORE_INCLUDE_DIRS})

target_link_libraries(zoom_join_and_share PRIVATE
  # NOT Qt6::Core (system, 6.10.2) — linking it pulls the system libQt6Core.so.6
  # into the process. libmeetingsdk.so's own bundled Qt6Gui/Qml/Quick/DBus
  # libraries then find that already-loaded (wrong-version) Qt6Core first —
  # shared-object resolution is by SONAME, first-loaded-wins — and fail with
  # "undefined symbol ... version Qt_6_PRIVATE_API" because the two Qt6
  # builds' private ABI don't match. Confirmed by hitting exactly that error
  # with Qt6::Core linked, and it going away once switched to this. Link the
  # SDK's own bundled Qt6Core instead so only one Qt6 build is ever loaded.
  "${BUNDLED_QT6CORE}"
  "${SYSTEM_LIBSSL}"
  "${SYSTEM_LIBCRYPTO}"
  "${ZOOM_SDK_DIR}/libmeetingsdk.so"
)

# libmeetingsdk.so is a prebuilt vendor blob whose own internal dependencies
# (its bundled Qt6Gui/Qml/Quick/Network/DBus .so's, referencing each other's
# private-API symbols) resolve at load time via its own baked-in RUNPATH —
# NOT at our link time, since we only link the top-level .so, not its whole
# internal dependency graph. Without this flag the linker (this toolchain
# defaults to -z defs) refuses to produce a binary at all, even though it
# would run fine — this is standard practice when linking against a large
# prebuilt vendor SDK rather than a package your own build system controls.
target_link_options(zoom_join_and_share PRIVATE -Wl,--allow-shlib-undefined)

# So the binary finds libmeetingsdk.so (and, via its own baked-in RUNPATH,
# the bundled Qt6 it needs) without requiring LD_LIBRARY_PATH at run time.
set_target_properties(zoom_join_and_share PROPERTIES
  BUILD_RPATH "${ZOOM_SDK_DIR}"
  INSTALL_RPATH "${ZOOM_SDK_DIR}"
)
