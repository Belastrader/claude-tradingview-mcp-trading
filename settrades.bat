@echo off
cd C:\Users\PC\claude-tradingview-mcp-trading
powershell -command "(Get-Content .env -Raw) -replace 'MAX_TRADES_PER_DAY=\d+','MAX_TRADES_PER_DAY=1000' | Set-Content .env -Encoding UTF8"
railway variables set MAX_TRADES_PER_DAY=1000
echo MAX_TRADES_PER_DAY=1000 atualizado!
pause