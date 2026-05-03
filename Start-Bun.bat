@echo off
setlocal
pushd %~dp0

set NODE_ENV=production
bun server.js %*

popd
