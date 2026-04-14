@echo off
setlocal

set REPO_ROOT=C:\Users\NCassidy\Downloads\GCW-Discount-Presets
set APP_PATH=%REPO_ROOT%\apps\gcw-discount-app
set STORE=gerberchildrenswear.myshopify.com

cd /d %REPO_ROOT%
if errorlevel 1 exit /b 1

git fetch discount-prod main || exit /b 1
git checkout main || exit /b 1
git pull discount-prod main || exit /b 1

echo Current commit:
git rev-parse --short HEAD

cd /d %APP_PATH% || exit /b 1

rustup target add wasm32-unknown-unknown || exit /b 1
call npm ci || exit /b 1

cd /d %APP_PATH%\extensions\gcw-discount-function || exit /b 1
cargo build --release --target wasm32-unknown-unknown || exit /b 1

cd /d %APP_PATH%\extensions\gcw-shipping-function || exit /b 1
cargo build --release --target wasm32-unknown-unknown || exit /b 1

cd /d %APP_PATH%\extensions\gcw-tiered-discount || exit /b 1
cargo build --release --target wasm32-unknown-unknown || exit /b 1

cd /d %APP_PATH%\extensions\gcw-bxgy-discount || exit /b 1
cargo build --release --target wasm32-unknown-unknown || exit /b 1

cd /d %APP_PATH% || exit /b 1
call npx shopify auth login --store %STORE% || exit /b 1
call npx shopify app deploy --allow-updates --no-build || exit /b 1

echo Deployment complete.
endlocal
