@echo off
cd C:\Users\PC\claude-tradingview-mcp-trading
git add -A
git commit -m "estrategia agressiva 3m + cron 3min"
railway up
echo Deploy concluido!
pause