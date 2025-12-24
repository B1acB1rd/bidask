import dotenv from 'dotenv';
import { Cluster } from '@solana/web3.js';

dotenv.config();

// Network configuration
export type NetworkType = 'devnet' | 'testnet' | 'mainnet-beta';

export interface Config {
    // Network
    network: NetworkType;
    rpcUrl: string;
    wsUrl: string;

    // Wallet
    walletPrivateKey: string;

    // Telegram
    telegramBotToken: string;
    telegramChatId: string;

    // Trading parameters
    minProfitBps: number;
    maxSlippageBps: number;
    maxTradeSizeSol: number;
    minLiquidityUsd: number;

    // Performance
    priceRefreshMs: number;
    maxPriorityFeeLamports: number;
    useJitoBundles: boolean;
    jitoTipLamports: number;

    // Tokens
    monitoredTokens: string[];

    // Logging
    logLevel: string;
    logToFile: boolean;
}

function getEnvOrDefault(key: string, defaultValue: string): string {
    return process.env[key] || defaultValue;
}

function getEnvOrThrow(key: string): string {
    const value = process.env[key];
    if (!value) {
        throw new Error(`Missing required environment variable: ${key}`);
    }
    return value;
}

function getRpcUrl(network: NetworkType): string {
    switch (network) {
        case 'devnet':
            return getEnvOrDefault('RPC_URL_DEVNET', 'https://api.devnet.solana.com');
        case 'testnet':
            return getEnvOrDefault('RPC_URL_TESTNET', 'https://api.testnet.solana.com');
        case 'mainnet-beta':
            return getEnvOrDefault('RPC_URL_MAINNET', 'https://api.mainnet-beta.solana.com');
        default:
            throw new Error(`Unknown network: ${network}`);
    }
}

function getWsUrl(rpcUrl: string): string {
    return rpcUrl.replace('https://', 'wss://').replace('http://', 'ws://');
}

export function loadConfig(): Config {
    const network = (getEnvOrDefault('NETWORK', 'devnet') as NetworkType);
    const rpcUrl = getRpcUrl(network);

    return {
        // Network
        network,
        rpcUrl,
        wsUrl: getWsUrl(rpcUrl),

        // Wallet - required for trading
        walletPrivateKey: getEnvOrDefault('WALLET_PRIVATE_KEY', ''),

        // Telegram - optional but recommended
        telegramBotToken: getEnvOrDefault('TELEGRAM_BOT_TOKEN', ''),
        telegramChatId: getEnvOrDefault('TELEGRAM_CHAT_ID', ''),

        // Trading parameters
        minProfitBps: parseInt(getEnvOrDefault('MIN_PROFIT_BPS', '50')),
        maxSlippageBps: parseInt(getEnvOrDefault('MAX_SLIPPAGE_BPS', '100')),
        maxTradeSizeSol: parseFloat(getEnvOrDefault('MAX_TRADE_SIZE_SOL', '1')),
        minLiquidityUsd: parseFloat(getEnvOrDefault('MIN_LIQUIDITY_USD', '10000')),

        // Performance
        priceRefreshMs: parseInt(getEnvOrDefault('PRICE_REFRESH_MS', '5000')),
        maxPriorityFeeLamports: parseInt(getEnvOrDefault('MAX_PRIORITY_FEE_LAMPORTS', '100000')),
        useJitoBundles: getEnvOrDefault('USE_JITO_BUNDLES', 'true') === 'true',
        jitoTipLamports: parseInt(getEnvOrDefault('JITO_TIP_LAMPORTS', '10000')),

        // Tokens - SOL wrapped + USDC by default
        monitoredTokens: getEnvOrDefault(
            'MONITORED_TOKENS',
            'So11111111111111111111111111111111111111112,EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
        ).split(',').map(t => t.trim()),

        // Logging
        logLevel: getEnvOrDefault('LOG_LEVEL', 'info'),
        logToFile: getEnvOrDefault('LOG_TO_FILE', 'true') === 'true',
    };
}

// Singleton config instance
let configInstance: Config | null = null;

export function getConfig(): Config {
    if (!configInstance) {
        configInstance = loadConfig();
    }
    return configInstance;
}

// Well-known token addresses
export const TOKENS = {
    SOL: 'So11111111111111111111111111111111111111112',
    USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    RAY: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R',
    ORCA: 'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE',
    BONK: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
    JUP: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
} as const;

// DEX Program IDs
export const DEX_PROGRAMS = {
    JUPITER_V6: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
    RAYDIUM_AMM_V4: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
    RAYDIUM_CLMM: 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
    ORCA_WHIRLPOOL: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
} as const;

export default getConfig;
