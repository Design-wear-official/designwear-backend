import { NextResponse, NextRequest } from 'next/server';
import { db, auth } from '@/lib/config/database';

const MAX_EMOJIS = 60;

// Extract uid from Bearer token
async function getFirebaseUid(req: NextRequest): Promise<string | null> {
    const authHeader = req.headers.get('authorization');
    if (!authHeader?.startsWith('Bearer ')) return null;

    try {
        const token = authHeader.split('Bearer ')[1];
        const decodedToken = await auth.verifyIdToken(token);
        return decodedToken.uid;
    } catch {
        return null;
    }
}

// Get the user's saved emojis (most-recent first)
export async function GET(req: NextRequest) {
    try {
        const firebaseUid = await getFirebaseUid(req);
        if (!firebaseUid) {
            return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
        }

        const doc = await db.collection('userEmojis').doc(firebaseUid).get();

        if (!doc.exists) {
            return NextResponse.json({ success: true, data: { emojis: [] } });
        }

        return NextResponse.json({ success: true, data: { emojis: doc.data()?.emojis ?? [] } });
    } catch (error) {
        console.error('Error fetching user emojis:', error);
        return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 });
    }
}

// Replace the user's saved emoji list
export async function PUT(req: NextRequest) {
    try {
        const firebaseUid = await getFirebaseUid(req);
        if (!firebaseUid) {
            return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
        }

        const { emojis } = await req.json();

        if (!Array.isArray(emojis) || !emojis.every((e) => typeof e === 'string')) {
            return NextResponse.json(
                { success: false, error: 'emojis must be an array of strings' },
                { status: 400 },
            );
        }

        // De-dupe (keep first occurrence / most-recent) and cap the list.
        const deduped = [...new Set(emojis)].slice(0, MAX_EMOJIS);

        const ref = db.collection('userEmojis').doc(firebaseUid);
        await ref.set({ emojis: deduped, updatedAt: new Date().toISOString() }, { merge: true });

        return NextResponse.json({ success: true, data: { emojis: deduped } });
    } catch (error) {
        console.error('Error updating user emojis:', error);
        return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 });
    }
}
