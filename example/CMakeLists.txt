


cmake_minimum_required(VERSION 3.20)


enable_language(C CXX)


project(syntax)


add_executable(app)
target_sources(app PRIVATE main.cpp)
target_compile_options(app PRIVATE
  -Wall -Wextra -Wpedantic -Wconversion
)


