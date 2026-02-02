# ⚡ Flash Loan Arbitrage Bot

Multi-DEX arbitrage bot using Kamino flash loans on Solana.

## Features

- **Multi-DEX Scanning**: Raydium, Orca, Meteora, Phoenix
- **Dynamic Sizing**: Optimal flash loan amounts based on liquidity
- **Slippage Protection**: Estimates slippage before execution
- **Rate Limiting**: ThrottledConnection for free RPC tiers
- **API Monitoring**: REST API for stats and opportunities

## Trading Pairs

- SOL/USDC
- JUP/USDC
- JTO/USDC
- BONK/USDC
- WIF/USDC

## Quick Start

```bash
# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Edit .env with your RPC URL and wallet key

# Run in dry-run mode (recommended first)
npm start

# Enable live trading
# Edit .env: DRY_RUN=false, AUTO_EXECUTE=true
```

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `RPC_URL` | - | Solana RPC endpoint |
| `WALLET_PRIVATE_KEY` | - | Base58 encoded private key |
| `MIN_PROFIT_USD` | 10 | Minimum profit to execute |
| `MAX_SLIPPAGE_TOLERANCE` | 0.003 | Max 0.3% slippage |
| `SCAN_INTERVAL_MS` | 1000 | Scan every 1 second |
| `DRY_RUN` | true | Log only, no execution |
| `AUTO_EXECUTE` | false | Auto-execute opportunities |

## API Endpoints

- `GET /api/stats` - Bot statistics
- `GET /api/opportunities` - Recent opportunities
- `GET /api/health` - Health check

## Architecture

```
src/
├── arbitrage-bot.ts      # Main orchestration
├── scanner.ts            # Multi-DEX price scanner
├── executor.ts           # Flash loan execution
├── profit-calculator.ts  # Profit calculations
├── dynamic-sizer.ts      # Optimal amount sizing
└── utils/
    ├── throttled-connection.ts
    └── logger.ts
```

## Profit Calculation

```
netProfit = (spread × amount) - flashFee - buyFee - sellFee - slippage
```

DEX Fees:
- Phoenix: 0.10%
- Meteora: 0.20%
- Raydium/Orca: 0.25%
- Kamino Flash Loan: 0.001%

## VPS Deployment

```bash
# SSH to VPS
ssh ubuntu@your-vps-ip

# Clone and setup
git clone https://github.com/0xthannis/liquidation-bot.git
cd liquidation-bot/ts-bot
npm install

# Configure
cp .env.example .env
nano .env  # Add your keys

# Run with PM2
npm install -g pm2
pm2 start npm --name "arb-bot" -- start
pm2 logs arb-bot
```

## Safety

1. Always start with `DRY_RUN=true`
2. Monitor logs before enabling `AUTO_EXECUTE`
3. Use a dedicated wallet with limited funds
4. Never commit your `.env` file

## License

MIT
