@echo off
cd /d "%~dp0"
title 上传更新到 GitHub

set "GIT=C:\Program Files\Git\cmd\git.exe"
if not exist "%GIT%" set "GIT=git"

"%GIT%" rev-parse --is-inside-work-tree >nul 2>&1
if errorlevel 1 goto :notrepo

"%GIT%" add -A
"%GIT%" diff --cached --quiet
if not errorlevel 1 goto :nocommit

set "MSG="
if defined UPLOAD_MSG set "MSG=%UPLOAD_MSG%"
if not defined UPLOAD_MSG set /p "MSG=这次改了什么（直接回车用默认）："
if "%MSG%"=="" set "MSG=更新"

powershell -NoProfile -Command "[IO.File]::WriteAllText($env:TEMP+'\quota-commit.txt', $env:MSG, (New-Object System.Text.UTF8Encoding($false)))"
"%GIT%" commit -F "%TEMP%\quota-commit.txt"
if errorlevel 1 goto :commitfail
goto :push

:nocommit
echo 没有检测到文件改动，仍然尝试推送...

:push
echo.
echo 正在上传到 GitHub...
"%GIT%" push
if errorlevel 1 goto :pushfail

echo.
echo 上传成功。GitHub Actions 大约 1 分钟后自动部署完成。
echo 部署进度：https://github.com/S-winest/quota/actions
echo 线上地址：https://s-winest.github.io/quota/
echo.
pause
exit /b 0

:notrepo
echo [x] 这个目录不是 git 仓库。
pause
exit /b 1

:commitfail
echo.
echo [x] 提交失败，请把上面的信息发给我。
pause
exit /b 1

:pushfail
echo.
echo [x] 上传失败。如果弹出浏览器，请登录 GitHub 后重新双击本文件。
pause
exit /b 1
