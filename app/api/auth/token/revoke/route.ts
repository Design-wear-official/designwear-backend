import { NextResponse, NextRequest } from 'next/server';
import { auth } from '@/lib/config/database';

/**
 * POST /api/auth/token/revoke
 * Revokes all refresh tokens for the authenticated user, effectively signing them out everywhere.
 * Requires a valid Firebase ID token in the Authorization header.
 */
export async function POST(req: NextRequest) {
    try {
        const authHeader = req.headers.get('Authorization');
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return NextResponse.json({ success: false, error: 'Authorization header required' }, { status: 401 });
        }

        const idToken = authHeader.replace('Bearer ', '');

        // Verify the ID token first
        const decodedToken = await auth.verifyIdToken(idToken);
        const uid = decodedToken.uid;

        // Revoke all refresh tokens for this user
        await auth.revokeRefreshTokens(uid);

        return NextResponse.json({
            success: true,
            message: `All tokens for user ${uid} have been revoked.`
        });
    } catch (error: unknown) {
        console.error('Error in POST /api/auth/token/revoke:', error);
        const errorMessage = error instanceof Error ? error.message : 'Token revocation failed';
        return NextResponse.json({ success: false, error: errorMessage }, { status: 500 });
    }
}
