@echo off
echo === RouteFlow E2E Tests - Headed Chrome Mode ===
echo.
echo Tests will open Chrome windows you can watch in real-time.
echo Press Ctrl+C at any time to stop.
echo.

set PLAYWRIGHT_BASE_URL=https://routeflowweb-production.up.railway.app
set PLAYWRIGHT_TENANT_SLUG=e2e-routeflow
set PLAYWRIGHT_HEADED=1

cd /d %~dp0
npx playwright test --reporter=list --workers=1

echo.
echo === Test run complete ===
echo Open playwright-report\index.html for the full HTML report
pause
