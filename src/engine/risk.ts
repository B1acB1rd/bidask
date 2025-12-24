import { PriceQuote, ArbitrageOpportunity } from '../types';
import { getConfig } from '../config';
import { logger } from '../utils/logger';

export interface RiskLimits {
    maxTradeSizeSol: number;
    maxSlippageBps: number;
    minLiquidityUsd: number;
    maxPriceImpactBps: number;
    minProfitBps: number;
    maxGasLamports: number;
    maxPositionPercent: number;  // Max % of wallet balance to use
    dailyLossLimitUsd: number;
}

export interface RiskCheckResult {
    passed: boolean;
    reason?: string;
    adjustedSize?: number;
    warnings: string[];
}

export class RiskManager {
    private limits: RiskLimits;
    private config = getConfig();

    // Track daily P&L
    private dailyPnL = 0;
    private dailyStartTime = Date.now();
    private tradeCount = 0;
    private failedTrades = 0;

    constructor(limits?: Partial<RiskLimits>) {
        this.limits = {
            maxTradeSizeSol: limits?.maxTradeSizeSol ?? this.config.maxTradeSizeSol,
            maxSlippageBps: limits?.maxSlippageBps ?? this.config.maxSlippageBps,
            minLiquidityUsd: limits?.minLiquidityUsd ?? this.config.minLiquidityUsd,
            maxPriceImpactBps: limits?.maxPriceImpactBps ?? 200, // 2% max impact
            minProfitBps: limits?.minProfitBps ?? this.config.minProfitBps,
            maxGasLamports: limits?.maxGasLamports ?? this.config.maxPriorityFeeLamports,
            maxPositionPercent: limits?.maxPositionPercent ?? 50, // Max 50% of balance
            dailyLossLimitUsd: limits?.dailyLossLimitUsd ?? 50, // $50 max daily loss
        };
    }

    /**
     * Check if trade passes all risk criteria
     */
    checkTrade(opportunity: ArbitrageOpportunity, walletBalanceSol: number): RiskCheckResult {
        const warnings: string[] = [];

        // Reset daily tracking if new day
        this.checkDailyReset();

        // Check daily loss limit
        if (this.dailyPnL < -this.limits.dailyLossLimitUsd) {
            return {
                passed: false,
                reason: `Daily loss limit reached: $${Math.abs(this.dailyPnL).toFixed(2)}`,
                warnings,
            };
        }

        // Check minimum profit threshold
        if (opportunity.spreadBps < this.limits.minProfitBps) {
            return {
                passed: false,
                reason: `Spread ${opportunity.spreadBps.toFixed(2)} bps below minimum ${this.limits.minProfitBps} bps`,
                warnings,
            };
        }

        // Check trade size vs wallet balance
        const maxByBalance = walletBalanceSol * (this.limits.maxPositionPercent / 100);
        let adjustedSize = opportunity.tradeSize;

        if (adjustedSize > this.limits.maxTradeSizeSol) {
            adjustedSize = this.limits.maxTradeSizeSol;
            warnings.push(`Trade size capped to max: ${this.limits.maxTradeSizeSol} SOL`);
        }

        if (adjustedSize > maxByBalance) {
            adjustedSize = maxByBalance;
            warnings.push(`Trade size reduced to ${this.limits.maxPositionPercent}% of balance`);
        }

        if (adjustedSize < 0.01) {
            return {
                passed: false,
                reason: 'Trade size too small after adjustments',
                warnings,
            };
        }

        // Check price impact
        const buyImpact = opportunity.buyQuote.priceImpact * 100; // Convert to bps
        const sellImpact = opportunity.sellQuote.priceImpact * 100;

        if (buyImpact > this.limits.maxPriceImpactBps) {
            return {
                passed: false,
                reason: `Buy price impact ${buyImpact.toFixed(0)} bps exceeds limit`,
                warnings,
            };
        }

        if (sellImpact > this.limits.maxPriceImpactBps) {
            return {
                passed: false,
                reason: `Sell price impact ${sellImpact.toFixed(0)} bps exceeds limit`,
                warnings,
            };
        }

        // Check slippage potential
        const totalSlippage = buyImpact + sellImpact;
        if (totalSlippage > this.limits.maxSlippageBps) {
            return {
                passed: false,
                reason: `Combined slippage ${totalSlippage.toFixed(0)} bps too high`,
                warnings,
            };
        }

        // Add warning if slippage is notable
        if (totalSlippage > this.limits.maxSlippageBps / 2) {
            warnings.push(`Notable slippage: ${totalSlippage.toFixed(0)} bps`);
        }

        // Check liquidity
        if (opportunity.buyQuote.liquidity > 0 &&
            opportunity.buyQuote.liquidity < this.limits.minLiquidityUsd) {
            return {
                passed: false,
                reason: `Buy pool liquidity $${opportunity.buyQuote.liquidity.toFixed(0)} below minimum`,
                warnings,
            };
        }

        if (opportunity.sellQuote.liquidity > 0 &&
            opportunity.sellQuote.liquidity < this.limits.minLiquidityUsd) {
            return {
                passed: false,
                reason: `Sell pool liquidity $${opportunity.sellQuote.liquidity.toFixed(0)} below minimum`,
                warnings,
            };
        }

        // Check if profit covers expected gas costs
        const expectedGasCost = 0.002; // ~0.002 SOL for typical arb tx
        if (opportunity.tradeSize * (opportunity.spreadBps / 10000) < expectedGasCost * 2) {
            warnings.push('Profit margin tight relative to gas costs');
        }

        // Check opportunity freshness
        const age = Date.now() - opportunity.detectedAt;
        if (age > 2000) { // Older than 2 seconds
            warnings.push(`Opportunity is ${(age / 1000).toFixed(1)}s old - may be stale`);
        }

        return {
            passed: true,
            adjustedSize,
            warnings,
        };
    }

    /**
     * Calculate optimal position size
     */
    calculateOptimalSize(
        opportunity: ArbitrageOpportunity,
        walletBalanceSol: number
    ): number {
        // Start with max allowed
        let size = Math.min(
            opportunity.tradeSize,
            this.limits.maxTradeSizeSol,
            walletBalanceSol * (this.limits.maxPositionPercent / 100)
        );

        // Reduce size based on price impact
        // Higher impact = smaller size
        const avgImpact = (opportunity.buyQuote.priceImpact + opportunity.sellQuote.priceImpact) / 2;
        if (avgImpact > 0.5) { // >0.5% impact
            size *= 0.5;
        } else if (avgImpact > 0.25) {
            size *= 0.75;
        }

        // Reduce size if spread is marginal
        if (opportunity.spreadBps < this.limits.minProfitBps * 1.5) {
            size *= 0.5; // Be conservative with marginal opportunities
        }

        // Minimum viable size
        return Math.max(size, 0.01);
    }

    /**
     * Record trade result for daily tracking
     */
    recordTrade(profitUsd: number, success: boolean): void {
        this.tradeCount++;
        if (success) {
            this.dailyPnL += profitUsd;
        } else {
            this.failedTrades++;
        }

        logger.info(`Trade recorded: ${success ? '✅' : '❌'} P&L: $${profitUsd.toFixed(2)}, Daily: $${this.dailyPnL.toFixed(2)}`);
    }

    /**
     * Check if new day and reset counters
     */
    private checkDailyReset(): void {
        const now = Date.now();
        const dayMs = 24 * 60 * 60 * 1000;

        if (now - this.dailyStartTime > dayMs) {
            logger.info(`Daily reset: Yesterday P&L: $${this.dailyPnL.toFixed(2)}, Trades: ${this.tradeCount}`);
            this.dailyPnL = 0;
            this.dailyStartTime = now;
            this.tradeCount = 0;
            this.failedTrades = 0;
        }
    }

    /**
     * Get current stats
     */
    getStats() {
        return {
            dailyPnL: this.dailyPnL,
            tradeCount: this.tradeCount,
            failedTrades: this.failedTrades,
            successRate: this.tradeCount > 0
                ? ((this.tradeCount - this.failedTrades) / this.tradeCount * 100).toFixed(1) + '%'
                : 'N/A',
            dailyLimitRemaining: this.limits.dailyLossLimitUsd + this.dailyPnL,
        };
    }

    /**
     * Get current limits
     */
    getLimits(): RiskLimits {
        return { ...this.limits };
    }

    /**
     * Update limits
     */
    updateLimits(newLimits: Partial<RiskLimits>): void {
        this.limits = { ...this.limits, ...newLimits };
        logger.info('Risk limits updated', this.limits);
    }
}

export default RiskManager;
