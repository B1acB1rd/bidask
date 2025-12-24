
import 'dotenv/config';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { TelegramNotifier } from '../src/telegram/bot';
import { ArbitrageOpportunity, DexType } from '../src/types';
import { logger } from '../src/utils/logger';
import { TOKENS } from '../src/config';

async function runSimulation() {
    logger.info('🧪 Starting Simulation...');

    // Initialize Telegram
    const telegram = new TelegramNotifier();
    await telegram.initialize();

    // Create mock quotes
    const buyQuote: any = {
        dex: 'raydium',
        inputMint: TOKENS.USDC,
        outputMint: TOKENS.SOL,
        inputAmount: 100,
        outputAmount: 1.5,
        price: 0.015,
        priceImpact: 0,
        fees: 0.001,
        liquidity: 1000000,
        route: ['USDC', 'SOL'],
        timestamp: Date.now()
    };

    const sellQuote: any = {
        dex: 'jupiter',
        inputMint: TOKENS.SOL,
        outputMint: TOKENS.USDC,
        inputAmount: 1.5,
        outputAmount: 105,
        price: 70,
        priceImpact: 0,
        fees: 0.001,
        liquidity: 1000000,
        route: ['SOL', 'USDC'],
        timestamp: Date.now()
    };

    // Create a fake opportunity
    const mockOpportunity: ArbitrageOpportunity = {
        id: 'sim-' + Date.now(),
        tokenMint: TOKENS.SOL,
        tokenSymbol: 'SOL',
        buyDex: 'raydium' as DexType,
        buyPrice: 0.015,
        buyQuote: buyQuote,
        sellDex: 'jupiter' as DexType,
        sellPrice: 70,
        sellQuote: sellQuote,
        spreadBps: 500, // 5% profit
        estimatedProfitBps: 500,
        estimatedProfitUsd: 5.00,
        tradeSize: 1.5,
        tradeSizeUsd: 100,
        detectedAt: Date.now(),
        expiresAt: Date.now() + 60000
    };

    console.log('\n-----------------------------------');
    console.log('📢 Sending "Opportunity Detected" alert to Telegram...');
    await telegram.notifyOpportunity(mockOpportunity);
    console.log('✅ Sent!');

    console.log('\n-----------------------------------');
    console.log('💹 Simulating Trade Execution...');

    // Mock result
    const successResult: any = {
        success: true,
        opportunity: mockOpportunity,
        buyTxHash: '5KMz...buy...',
        sellTxHash: '5KMz...sell...',
        actualProfitUsd: 5.00,
        duration: 1200,
        executedAt: Date.now()
    };

    console.log('📢 Sending "Trade Success" alert to Telegram...');
    await telegram.notifyTrade(successResult);
    console.log('✅ Sent!');

    console.log('\n-----------------------------------');
    console.log('✨ Simulation Complete! Check your Telegram.');
    process.exit(0);
}

runSimulation().catch(console.error);
