import { NextResponse, NextRequest } from 'next/server';
import { db, firebaseReady } from '@/lib/config/database';
import { upsertInventoryRecord, deriveStockStatus } from '@/lib/services/syncService';
import { logger } from '@/lib/utils/logger';

function firebaseNotReadyResponse() {
    return NextResponse.json(
        {
            success: false,
            error: 'Firebase Admin SDK is not initialized. '
                + 'Set FIREBASE_SERVICE_ACCOUNT_KEY in the environment and redeploy.',
        },
        { status: 503 },
    );
}

/**
 * Inventory read endpoints.
 *   GET /api/inventory/summary            → counts by status + total units
 *   GET /api/inventory/list?status=lowStock → inventory records (optional status filter)
 */
export async function GET(req: NextRequest) {
    if (!firebaseReady) return firebaseNotReadyResponse();

    const url = new URL(req.url);
    const action = url.pathname.split('/').pop();

    try {
        if (action === 'summary') {
            const snap = await db.collection('inventory').get();
            let inStock = 0, lowStock = 0, outOfStock = 0, totalUnits = 0;
            snap.forEach((doc) => {
                const s = doc.data();
                totalUnits += s.stock ?? 0;
                if (s.status === 'lowStock') lowStock++;
                else if (s.status === 'outOfStock') outOfStock++;
                else inStock++;
            });
            return NextResponse.json({
                success: true,
                total: snap.size,
                inStock,
                lowStock,
                outOfStock,
                totalUnits,
            });
        }

        if (action === 'list') {
            const status = url.searchParams.get('status');
            let query: FirebaseFirestore.Query<FirebaseFirestore.DocumentData> =
                db.collection('inventory');
            if (status) query = query.where('status', '==', status);
            const snap = await query.get();
            return NextResponse.json({
                success: true,
                count: snap.size,
                data: snap.docs.map((doc) => ({ id: doc.id, ...doc.data() })),
            });
        }

        return NextResponse.json(
            { success: false, error: 'Unknown GET action. Use: summary | list' },
            { status: 404 },
        );
    } catch (error: unknown) {
        logger.error('Inventory GET error', error);
        return NextResponse.json(
            { success: false, error: error instanceof Error ? error.message : 'Internal server error' },
            { status: 500 },
        );
    }
}

/**
 * Inventory write endpoints.
 *   POST /api/inventory/backfill  → ensure every product has an inventory record (reconcile)
 *   POST /api/inventory/adjust    → transactional stock change + movement log
 *        body: { productId: string, delta: number, reason?, reference?, performedBy? }
 */
export async function POST(req: NextRequest) {
    if (!firebaseReady) return firebaseNotReadyResponse();

    const url = new URL(req.url);
    const action = url.pathname.split('/').pop();

    try {
        if (action === 'backfill') {
            const snap = await db.collection('products').get();
            let processed = 0, failed = 0, skipped = 0;
            for (const doc of snap.docs) {
                const p = doc.data();
                // Skip community / print-on-demand designs — they carry no stock.
                if (p.creatorHandle) {
                    skipped++;
                    continue;
                }
                try {
                    await upsertInventoryRecord(doc.id, {
                        name: p.title || p.name || '',
                        sku: p.sku || '',
                        stock: typeof p.stock === 'number' ? p.stock : 0,
                        lowStockThreshold: typeof p.lowStockThreshold === 'number' ? p.lowStockThreshold : 0,
                    });
                    processed++;
                } catch (e) {
                    failed++;
                    logger.error(`Inventory backfill failed for ${doc.id}:`, e);
                }
            }
            return NextResponse.json({ success: true, totalProducts: snap.size, processed, skipped, failed });
        }

        if (action === 'adjust') {
            const { productId, delta, reason = 'manual', reference = null, performedBy = 'system' } =
                await req.json();

            if (typeof productId !== 'string' || !productId || typeof delta !== 'number') {
                return NextResponse.json(
                    { success: false, error: 'productId (string) and delta (number) are required' },
                    { status: 400 },
                );
            }

            const result = await db.runTransaction(async (tx) => {
                const invRef = db.collection('inventory').doc(productId);
                const prodRef = db.collection('products').doc(productId);
                const invSnap = await tx.get(invRef);
                const prevStock = invSnap.exists ? (invSnap.data()?.stock ?? 0) : 0;
                const threshold = invSnap.exists ? (invSnap.data()?.lowStockThreshold ?? 0) : 0;
                const newStock = Math.max(0, prevStock + delta);
                const now = new Date().toISOString();

                tx.set(invRef, {
                    productId,
                    stock: newStock,
                    status: deriveStockStatus(newStock, threshold),
                    updatedAt: now,
                }, { merge: true });

                // Keep the catalog product doc's stock in lock-step.
                tx.set(prodRef, {
                    stock: newStock,
                    stockStatus: newStock > 0 ? 'inStock' : 'outOfStock',
                    updatedAt: now,
                }, { merge: true });

                tx.set(db.collection('inventoryMovements').doc(), {
                    productId,
                    type: delta >= 0 ? 'in' : 'out',
                    quantity: Math.abs(delta),
                    previousStock: prevStock,
                    newStock,
                    reason,
                    reference,
                    performedBy,
                    source: 'api-adjust',
                    timestamp: now,
                    createdAt: now,
                });

                return { prevStock, newStock };
            });

            return NextResponse.json({ success: true, productId, ...result });
        }

        return NextResponse.json(
            { success: false, error: 'Unknown POST action. Use: backfill | adjust' },
            { status: 404 },
        );
    } catch (error: unknown) {
        logger.error('Inventory POST error', error);
        return NextResponse.json(
            { success: false, error: error instanceof Error ? error.message : 'Internal server error' },
            { status: 500 },
        );
    }
}
