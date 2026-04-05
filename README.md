# MEV Bot — Multi-Chain Multi-Strategy

Multi-chain MEV bot with Telegram control. Supports sandwich, arbitrage, and copy-trade strategies.

## Chains
- **Base** — Arbitrage + Copy-trade
- **BSC** — Sandwich + Arbitrage + Copy-trade  
- **Ethereum** — Sandwich + Arbitrage + Copy-trade

## Setup

1. Copy `.env.example` to `.env` and fill in your values
2. `npm install`
3. `npx hardhat compile`
4. Deploy contracts: `npm run deploy:base` / `npm run deploy:bsc`
5. Update `.env` with contract addresses
6. `npm start`

## Telegram Commands

See `/start` in the bot for full command list.

## Deployment (Railway)

See deployment guide for step-by-step Railway setup.

## Security

- All trading functions are `onlyOwner`
- Private keys are NEVER committed to git
- Contract is verified on block explorers
