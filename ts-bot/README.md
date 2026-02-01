# 💀 Kamino Liquidation Bot PRO

Professional liquidation bot for Kamino Lending with:
- **Pyth WebSocket** - Real-time price monitoring
- **Price-indexed obligations** - O(1) lookup for liquidation opportunities
- **Dynamic liquidation amounts** - Handles $100 to $10M+ positions
- **Flash loans** - No capital required
- **Jupiter swaps** - Optimal collateral conversion

## Architecture

```
1. STARTUP (~5 min)
   ├─ Load Kamino market & reserves
   ├─ Fetch all ~98k obligations
   ├─ Parse deposits/borrows with SDK
   ├─ Calculate liquidation prices
   └─ Build price-indexed lookup

2. RUNTIME
   ├─ WebSocket Pyth prices (15 tokens)
   ├─ Price drops → instant bucket lookup
   └─ Found liquidatable? → Execute

3. EXECUTION
   ├─ Flash borrow (repay token)
   ├─ Liquidate obligation
   ├─ Jupiter swap (collateral → repay)
   ├─ Flash repay + 0.001% fee
   └─ Keep profit
```

## Requirements

- Node.js 18+
- Helius RPC (recommended for rate limits)
- ~200 MB RAM
- Solana wallet with some SOL for gas

## Installation

```bash
# Clone repo
git clone <your-repo-url>
cd ts-bot

# Install dependencies
npm install

# Configure environment
cp .env.example .env
nano .env  # Edit with your keys
```

## Configuration (.env)

```env
# Helius RPC (get free key at helius.dev)
HELIUS_RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY

# Wallet private key (base58)
WALLET_PRIVATE_KEY=your_private_key_here
```

## Running

```bash
# Development
npm run dev

# Production
npm start
```

## VPS Deployment (Amazon EC2 / Ubuntu)

See deployment commands below.

---

## Program IDs (Kamino)

- **Kamino Lending**: `KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD`
- **Main Market**: `7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF`

## Stats Tracked

- Total obligations indexed
- Price updates received
- Liquidation opportunities found
- Successful liquidations
- Total profit (USD)

## License

MIT
