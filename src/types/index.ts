/**
 * Shared types for the arbitrage bot
 */

// DEX identifiers
export type DexType = 'jupiter' | 'raydium' | 'orca';

// Price quote from a DEX
export interface PriceQuote {
    dex: DexType;
    inputMint: string;
    outputMint: string;
    inputAmount: number;      // Amount to swap
    outputAmount: number;     // Amount received
    price: number;            // Price per token
    priceImpact: number;      // Price impact percentage
    fees: number;             // Trading fees in output token
    liquidity: number;        // Pool liquidity in USD
    route?: string[];         // Routing path
    timestamp: number;        // Quote timestamp
}

// Arbitrage opportunity
export interface ArbitrageOpportunity {
    id: string;
    tokenMint: string;
    tokenSymbol?: string;

    // Buy side
    buyDex: DexType;
    buyPrice: number;
    buyQuote: PriceQuote;

    // Sell side
    sellDex: DexType;
    sellPrice: number;
    sellQuote: PriceQuote;

    // Profit calculation
    spreadBps: number;           // Spread in basis points
    estimatedProfitBps: number;  // After fees
    estimatedProfitUsd: number;  // Estimated USD profit
    tradeSize: number;           // Trade size in tokens
    tradeSizeUsd: number;        // Trade size in USD

    // Timing
    detectedAt: number;
    expiresAt: number;
}

// Trade execution result
export interface TradeResult {
    success: boolean;
    opportunity: ArbitrageOpportunity;

    // Buy leg
    buyTxHash?: string;
    buyActualAmount?: number;
    buySlippage?: number;

    // Sell leg
    sellTxHash?: string;
    sellActualAmount?: number;
    sellSlippage?: number;

    // Profit
    actualProfitBps?: number;
    actualProfitUsd?: number;

    // Fees
    gasCostLamports?: number;
    gasCostUsd?: number;

    // Errors
    error?: string;
    errorCode?: string;

    executedAt: number;
    duration: number;  // Execution time in ms
}

// Bot status
export interface BotStatus {
    isRunning: boolean;
    network: string;
    walletAddress?: string;
    balanceSol: number;

    // Stats
    opportunitiesDetected: number;
    tradesExecuted: number;
    tradesSuccessful: number;
    tradesFailed: number;
    totalProfitUsd: number;

    // Performance
    uptime: number;
    lastPriceUpdate: number;
    avgLatencyMs: number;
}

// Token info
export interface TokenInfo {
    mint: string;
    symbol: string;
    name: string;
    decimals: number;
    logoUri?: string;
}

// Pool info
export interface PoolInfo {
    address: string;
    dex: DexType;
    tokenA: string;
    tokenB: string;
    reserveA: number;
    reserveB: number;
    liquidity: number;
    fee: number;
    apy?: number;
}
