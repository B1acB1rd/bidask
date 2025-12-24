# 🚀 Solana DEX Arbitrage Bot

A fast, efficient arbitrage bot for Solana that detects price differences across DEXs (Jupiter, Raydium, Orca) and executes profitable trades atomically.

![Solana](https://img.shields.io/badge/Solana-black?style=for-the-badge&logo=solana)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=node.js&logoColor=white)

## ✨ Features

- **Multi-DEX Support**: Jupiter, Raydium, Orca integration
- **Parallel Price Fetching**: Simultaneous quotes from all DEXs
- **MEV Protection**: Jito bundle support for front-run protection
- **Risk Management**: Configurable limits, slippage protection, daily loss limits
- **Telegram Integration**: Real-time alerts and bot control
- **Devnet Testing**: Safe testing with fake SOL before mainnet

## 🛠️ Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment

Copy the example environment file:
```bash
copy .env.example .env
```

Edit `.env` with your settings:
- `NETWORK=devnet` (start with devnet!)
- `WALLET_PRIVATE_KEY=your_key_here`
- `TELEGRAM_BOT_TOKEN=your_bot_token`
- `TELEGRAM_CHAT_ID=your_chat_id`

### 3. Build the Project

```bash
npm run build
```

### 4. Run on Devnet (Recommended First!)

```bash
npm run start:devnet
```

### 5. Run on Mainnet (After Testing)

```bash
npm run start:mainnet
```

## 📁 Project Structure

```
bidask/
├── src/
│   ├── config/          # Configuration and constants
│   ├── engine/          # Core arbitrage logic
│   │   ├── detector.ts  # Opportunity detection
│   │   ├── executor.ts  # Trade execution
│   │   └── risk.ts      # Risk management
│   ├── feeds/           # Price feed integrations
│   │   ├── aggregator.ts
│   │   ├── jupiter.ts
│   │   ├── raydium.ts
│   │   └── orca.ts
│   ├── telegram/        # Telegram bot
│   ├── wallet/          # Wallet management
│   ├── types/           # TypeScript types
│   ├── utils/           # Utilities
│   └── index.ts         # Main entry point
├── .env.example         # Environment template
├── package.json
└── tsconfig.json
```

## 🔧 Configuration

### Trading Parameters

| Parameter | Description | Default |
|-----------|-------------|---------|
| `MIN_PROFIT_BPS` | Minimum spread to trigger (basis points) | 50 (0.5%) |
| `MAX_SLIPPAGE_BPS` | Maximum allowed slippage | 100 (1%) |
| `MAX_TRADE_SIZE_SOL` | Maximum trade size in SOL | 1 |
| `MIN_LIQUIDITY_USD` | Minimum pool liquidity | $10,000 |

### Performance Settings

| Parameter | Description | Default |
|-----------|-------------|---------|
| `PRICE_REFRESH_MS` | Price update interval | 500ms |
| `USE_JITO_BUNDLES` | Enable Jito MEV protection | true |
| `MAX_PRIORITY_FEE_LAMPORTS` | Max priority fee | 100,000 |

## 📱 Telegram Commands

| Command | Description |
|---------|-------------|
| `/start` | Start the bot |
| `/status` | Show bot status |
| `/balance` | Show wallet balance |
| `/stats` | Trading statistics |
| `/opportunities` | Active opportunities |
| `/pause` | Pause trading |
| `/resume` | Resume trading |
| `/help` | Show help |

## 🔒 Security

- **Never commit `.env`** - It's gitignored
- **Use a dedicated wallet** - Not your main wallet
- **Start small** - Test with small amounts first
- **Monitor constantly** - Crypto trading is risky

## ⚠️ Important Disclaimers

1. **Test on Devnet First**: Always test thoroughly before using real funds
2. **Financial Risk**: Arbitrage trading involves significant risk
3. **No Guarantees**: Past performance doesn't indicate future results
4. **Gas Costs**: Failed transactions still cost gas
5. **Competition**: Professional bots compete for the same opportunities

## 🚀 Getting Started Walkthrough

1. **Get a Telegram Bot Token**:
   - Message @BotFather on Telegram
   - Send `/newbot` and follow instructions
   - Copy the token to `.env`

2. **Get Your Telegram Chat ID**:
   - Message @userinfobot on Telegram
   - Copy your ID to `.env`

3. **Create a Test Wallet**:
   ```bash
   node -e "const {Keypair} = require('@solana/web3.js'); const kp = Keypair.generate(); console.log('Public:', kp.publicKey.toBase58()); console.log('Private:', require('bs58').encode(kp.secretKey));"
   ```

4. **Get Devnet SOL**:
   - Visit https://solfaucet.com/
   - Or the bot will auto-airdrop on devnet

5. **Run & Monitor**:
   ```bash
   npm run start:devnet
   ```

## 📊 How It Works

```
┌─────────────────────────────────────────────────────────────────┐
│                     SOLANA DEX ARBITRAGE BOT                     │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐                       │
│  │ Jupiter  │  │ Raydium  │  │   Orca   │   Price Feeds         │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘                       │
│       │             │             │                              │
│       └─────────────┼─────────────┘                              │
│                     ▼                                            │
│            ┌────────────────┐                                    │
│            │  Aggregator    │  Parallel fetch, normalize         │
│            └───────┬────────┘                                    │
│                    ▼                                             │
│            ┌────────────────┐                                    │
│            │   Detector     │  Find spreads, rank opportunities  │
│            └───────┬────────┘                                    │
│                    ▼                                             │
│            ┌────────────────┐                                    │
│            │ Risk Manager   │  Validate, size positions          │
│            └───────┬────────┘                                    │
│                    ▼                                             │
│            ┌────────────────┐                                    │
│            │   Executor     │  Atomic swap, Jito bundles         │
│            └───────┬────────┘                                    │
│                    ▼                                             │
│            ┌────────────────┐                                    │
│            │   Telegram     │  Alerts & control                  │
│            └────────────────┘                                    │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## 📜 License

MIT License - Use at your own risk.

---

**Built with ❤️ for Solana**
