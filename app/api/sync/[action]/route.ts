import { NextResponse, NextRequest } from 'next/server';
import { syncProductToDatabase, checkDocumentExists } from '@/lib/services/syncService';
import { db, firebaseReady } from '@/lib/config/database';
import { logger } from '@/lib/utils/logger';

function firebaseNotReadyResponse() {
    return NextResponse.json(
        {
            success: false,
            error: 'Firebase Admin SDK is not initialized on Vercel. '
                + 'Go to Vercel Dashboard → your project → Settings → Environment Variables '
                + 'and add FIREBASE_SERVICE_ACCOUNT_KEY (paste the full service account JSON). '
                + 'Then redeploy.',
        },
        { status: 503 },
    );
}

export async function GET(req: NextRequest) {
    if (!firebaseReady) return firebaseNotReadyResponse();
    try {
        const url = new URL(req.url);
        const action = url.pathname.split('/').pop();

        if (action === 'status') {
            const pendingQuery = await db.collection('products')
                .where('syncedToDb', 'in', [false, null])
                .get();

            const failedQuery = await db.collection('operationLogs')
                .where('operationType', '==', 'sync')
                .where('error', '!=', null)
                .get();

            const snapshot = await db.collection('products')
                .where('syncedToDb', '==', true)
                .orderBy('syncedAt', 'desc')
                .limit(1)
                .get();

            const lastSync = snapshot.empty ? null : snapshot.docs[0].data().syncedAt;

            return NextResponse.json({
                status: 'idle',
                pendingItems: pendingQuery.size,
                failedItems: failedQuery.size,
                lastSync
            });
        }

        return NextResponse.json({ error: 'Endpoint not found' }, { status: 404 });
    } catch {
        console.error('Status fetch error');
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}

export async function POST(req: NextRequest) {
    if (!firebaseReady) return firebaseNotReadyResponse();
    try {
        const url = new URL(req.url);
        const action = url.pathname.split('/').pop();

        if (action === 'trigger') {
            const { documentId, documentType } = await req.json();

            if (documentType === 'product') {
                // Check if document exists before attempting sync
                const exists = await checkDocumentExists(documentId);
                if (!exists) {
                    logger.warn(`Skipping sync for non-existent product: ${documentId}`);
                    return NextResponse.json(
                        {
                            success: false,
                            message: `Product ${documentId} not found in Sanity`,
                            documentId
                        },
                        { status: 404 }
                    );
                }

                const result = await syncProductToDatabase(documentId);
                const statusCode = result.success ? 200 : 400;
                return NextResponse.json(result, { status: statusCode });
            } else {
                return NextResponse.json({ error: 'Unsupported document type' }, { status: 400 });
            }
        }

        if (action === 'webhook') {
            const { _type, _id } = await req.json();

            if (_type === 'product') {
                // Check if document exists before attempting sync
                const exists = await checkDocumentExists(_id);
                if (!exists) {
                    logger.warn(`Skipping webhook sync for non-existent product: ${_id}`);
                    return NextResponse.json(
                        {
                            success: false,
                            message: `Product ${_id} not found in Sanity`,
                            documentId: _id
                        }
                    );
                }

                const result = await syncProductToDatabase(_id);
                return NextResponse.json({
                    success: result.success,
                    documentId: _id,
                    message: result.message
                });
            }

            return NextResponse.json({ success: true, message: 'Webhook received but no action needed' });
        }

        return NextResponse.json({ error: 'Endpoint not found' }, { status: 404 });

    } catch (error: unknown) {
        logger.error('Sync POST error', error);
        const errorMessage = error instanceof Error ? error.message : 'Internal server error';
        return NextResponse.json({
            error: errorMessage,
            success: false
        }, { status: 500 });
    }
}
