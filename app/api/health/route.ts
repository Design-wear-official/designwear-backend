import { NextResponse } from 'next/server';
import { firebaseReady, db } from '@/lib/config/database';

export async function GET() {
    try {
        const healthStatus = {
            status: 'ok',
            timestamp: new Date().toISOString(),
            uptime: process.uptime(),
            services: {
                database: 'unknown'
            }
        };

        if (!firebaseReady) {
            healthStatus.services.database = 'misconfigured';
            return NextResponse.json(
                {
                    ...healthStatus,
                    status: 'degraded',
                    error: 'FIREBASE_SERVICE_ACCOUNT_KEY is not set. Add it to Vercel Environment Variables and redeploy.'
                },
                { status: 503 }
            );
        }

        try {
            await db.listCollections();
            healthStatus.services.database = 'connected';
        } catch (dbError: unknown) {
            console.error('Health check: Database connection failed', dbError);
            healthStatus.services.database = 'disconnected';
            healthStatus.status = 'degraded';
        }

        const statusCode = healthStatus.status === 'ok' ? 200 : 503;
        return NextResponse.json(healthStatus, { status: statusCode });
    } catch (error: unknown) {
        console.error('Health check failed:', error);
        return NextResponse.json({
            status: 'error',
            timestamp: new Date().toISOString(),
            error: error instanceof Error ? error.message : 'Internal server error during health check'
        }, { status: 500 });
    }
}
