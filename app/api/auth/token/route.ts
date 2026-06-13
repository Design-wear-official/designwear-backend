import { NextResponse, NextRequest } from 'next/server';
import { auth } from '@/lib/config/database';

/**
 * POST /api/auth/token
 * Issues a new long-lived API token (custom token) for the authenticated Firebase user.
 * Requires a valid Firebase ID token in the Authorization header.
 */
export async function POST(req: NextRequest) {
    try {
        const authHeader = req.headers.get('Authorization');
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return NextResponse.json({ success: false, error: 'Authorization header required' }, { status: 401 });
        }

        const idToken = authHeader.replace('Bearer ', '');

        // Verify the ID token
        const decodedToken = await auth.verifyIdToken(idToken);
        const uid = decodedToken.uid;

        // Create a custom token for the user
        const customToken = await auth.createCustomToken(uid);

        return NextResponse.json({
            success: true,
            data: {
                token: customToken,
                uid,
            }
        });
    } catch (error: unknown) {
        console.error('Error in POST /api/auth/token:', error);
        const errorMessage = error instanceof Error ? error.message : 'Token issuance failed';
        return NextResponse.json({ success: false, error: errorMessage }, { status: 500 });
    }
}

/**
 * GET /api/auth/token
 * Returns the current authenticated user info for a given Bearer token.
 */
export async function GET(req: NextRequest) {
    try {
        const authHeader = req.headers.get('Authorization');
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return NextResponse.json({ success: false, error: 'Authorization header required' }, { status: 401 });
        }

        const idToken = authHeader.replace('Bearer ', '');
        const decodedToken = await auth.verifyIdToken(idToken);

        return NextResponse.json({
            success: true,
            data: {
                uid: decodedToken.uid,
                email: decodedToken.email,
                emailVerified: decodedToken.email_verified,
            }
        });
    } catch (error: unknown) {
        console.error('Error in GET /api/auth/token:', error);
        const errorMessage = error instanceof Error ? error.message : 'Token verification failed';
        return NextResponse.json({ success: false, error: errorMessage }, { status: 401 });
    }
}
