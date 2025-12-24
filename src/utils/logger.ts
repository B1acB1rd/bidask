import winston from 'winston';
import path from 'path';
import { getConfig } from '../config';

const config = getConfig();

// Custom format for console output
const consoleFormat = winston.format.combine(
    winston.format.timestamp({ format: 'HH:mm:ss.SSS' }),
    winston.format.colorize(),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
        const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
        return `[${timestamp}] ${level}: ${message}${metaStr}`;
    })
);

// Custom format for file output
const fileFormat = winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
    winston.format.json()
);

// Create transports
const transports: winston.transport[] = [
    new winston.transports.Console({
        format: consoleFormat,
    }),
];

// Add file transport if enabled
if (config.logToFile) {
    const logsDir = path.join(process.cwd(), 'logs');

    transports.push(
        new winston.transports.File({
            filename: path.join(logsDir, 'error.log'),
            level: 'error',
            format: fileFormat,
        }),
        new winston.transports.File({
            filename: path.join(logsDir, 'combined.log'),
            format: fileFormat,
        }),
        new winston.transports.File({
            filename: path.join(logsDir, 'trades.log'),
            level: 'info',
            format: fileFormat,
        })
    );
}

export const logger = winston.createLogger({
    level: config.logLevel,
    defaultMeta: { service: 'solana-arb-bot' },
    transports,
});

// Helper functions for common log patterns
export function logOpportunity(data: {
    buyDex: string;
    sellDex: string;
    token: string;
    spreadBps: number;
    estimatedProfit: number;
}) {
    logger.info('🎯 Arbitrage opportunity detected', data);
}

export function logTrade(data: {
    type: 'BUY' | 'SELL';
    dex: string;
    token: string;
    amount: number;
    price: number;
    txHash?: string;
    success: boolean;
    error?: string;
}) {
    if (data.success) {
        logger.info(`✅ ${data.type} executed`, data);
    } else {
        logger.error(`❌ ${data.type} failed`, data);
    }
}

export function logPrice(dex: string, token: string, price: number, liquidity: number) {
    logger.debug(`💰 Price update`, { dex, token, price, liquidity });
}

export function logError(message: string, error: Error) {
    logger.error(message, { error: error.message, stack: error.stack });
}

export default logger;
