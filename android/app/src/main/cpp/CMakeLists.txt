cmake_minimum_required(VERSION 3.22.1)

project(aura_dsp LANGUAGES CXX)

add_library(
        aura_dsp
        SHARED
        aura_native_dsp.cpp
)

target_compile_features(aura_dsp PRIVATE cxx_std_17)

target_compile_options(aura_dsp PRIVATE
        -O3
        -ffast-math
        -fno-exceptions
        -fno-rtti
)

find_library(log-lib log)

target_link_libraries(
        aura_dsp
        ${log-lib}
)
