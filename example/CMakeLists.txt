


cmake_minimum_required(VERSION 3.20)



project(syntax)
enable_language(C CXX)

set(CMAKE_MESSAGE_LOG_LEVEL TRACE)
message(WARNING "A CMake warning message")
message(VERBOSE "A CMake verbose message")
message(DEBUG "A CMake debug message")
message(TRACE "A CMake trace message")


add_executable(app)
target_sources(app PRIVATE main.cpp)


