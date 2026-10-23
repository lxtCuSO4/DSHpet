@echo off
chcp 65001 >nul
title dsh-pet 桌宠
set "PKG=%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-pet"
if not exist "%PKG%\lib\standalone.js" (
  echo [x] 找不到 dsh-pet 插件：%PKG%
  pause & exit /b 1
)
set "NODE="
for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE set "NODE=%%i"
if not defined NODE set "NODE=D:\nodejs\node.exe"
cd /d "%PKG%"
echo 启动桌宠……（关掉这个窗口 = 收起桌宠）
echo.
"%NODE%" lib\standalone.js
echo.
echo 桌宠已退出。
pause