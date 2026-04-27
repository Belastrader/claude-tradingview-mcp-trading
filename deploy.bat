@echo off
cd C:\Users\PC\claude-tradingview-mcp-trading

:: Limpa locks do git
if exist .git\index.lock del /f .git\index.lock
if exist .git\HEAD.lock del /f .git\HEAD.lock

git add bot.js railway.json dashboard.js package.json Dockerfile rules.json bot_indicator.pine .env
git commit -m "v4.4: filtro ATR anti-chop, cooldown 20min pos-SL, pine script atualizado"
echo.
echo === Fazendo deploy no Railway ===
railway up
echo.
echo === Deploy concluido! ===
pause
