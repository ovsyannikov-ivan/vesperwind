# The only allowed liblzma is the static target from our verified XZ source.
if(NOT TARGET liblzma)
  message(FATAL_ERROR "Build the pinned liblzma target before libarchive")
endif()
set(LIBLZMA_FOUND TRUE)
set(LibLZMA_FOUND TRUE)
set(LIBLZMA_LIBRARIES liblzma)
set(LIBLZMA_INCLUDE_DIR "${XZ_SOURCE}/src/liblzma/api")
set(LIBLZMA_INCLUDE_DIRS "${LIBLZMA_INCLUDE_DIR}")
# These upstream try_compile probes cannot link an unbuilt subdirectory target.
# The pinned static library's API and definitions are known, never guessed from
# a host system library. Raw decoding is also tested by the worker build recipe.
set(WITHOUT_LZMA_API_STATIC FALSE CACHE INTERNAL "" FORCE)
set(LZMA_API_STATIC TRUE CACHE INTERNAL "" FORCE)
set(HAVE_LZMA_STREAM_ENCODER_MT FALSE CACHE INTERNAL "" FORCE)
