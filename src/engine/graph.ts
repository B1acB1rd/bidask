import { TOKENS } from '../config';
import { PriceQuote } from '../types';

interface Edge {
    to: string;
    dex: string;
    price: number;
    quote?: PriceQuote;
}

export class TokenGraph {
    // Adjacency list: fromToken -> Edge[]
    private adjList: Map<string, Edge[]> = new Map();

    constructor() {
        // Initialize nodes for all known tokens
        Object.values(TOKENS).forEach(token => {
            this.adjList.set(token, []);
        });
    }

    /**
     * Update or add an edge in the graph
     */
    updateEdge(from: string, to: string, dex: string, price: number, quote?: PriceQuote): void {
        if (!this.adjList.has(from)) this.adjList.set(from, []);

        const edges = this.adjList.get(from)!;
        const existingIndex = edges.findIndex(e => e.to === to && e.dex === dex);

        if (existingIndex >= 0) {
            edges[existingIndex] = { to, dex, price, quote };
        } else {
            edges.push({ to, dex, price, quote });
        }
    }

    /**
     * Get neighbors of a token
     */
    getNeighbors(token: string): Edge[] {
        return this.adjList.get(token) || [];
    }

    /**
     * Find triangular opportunities (3-hop cycles)
     * SOL -> A -> B -> SOL
     */
    findTriangles(startToken: string): { path: Edge[], profitBps: number }[] {
        const opportunities: { path: Edge[], profitBps: number }[] = [];
        const edges1 = this.getNeighbors(startToken);

        for (const e1 of edges1) {
            const edges2 = this.getNeighbors(e1.to);

            for (const e2 of edges2) {
                // Don't go back to start immediately
                if (e2.to === startToken) continue;

                const edges3 = this.getNeighbors(e2.to);

                for (const e3 of edges3) {
                    // unexpected cycle length or wrong return
                    if (e3.to !== startToken) continue;

                    // We found a cycle: start -> e1 -> e2 -> e3 -> start
                    // Calculate composite price: 1.0 * p1 * p2 * p3
                    // Note: Prices might need to be inverted depending on direction, 
                    // but assuming normalized "output per 1 input" rates:

                    const compositeRate = e1.price * e2.price * e3.price;

                    if (compositeRate > 1.000) { // > 1.0 means profit
                        const profitBps = (compositeRate - 1) * 10000;
                        opportunities.push({
                            path: [e1, e2, e3],
                            profitBps
                        });
                    }
                }
            }
        }
        return opportunities;
    }
}
