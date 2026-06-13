import { NextResponse, NextRequest } from 'next/server';
import { db, auth } from '@/lib/config/database';

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

// Update cart items
export async function PUT(req: NextRequest) {
    try {
        const firebaseUid = await getFirebaseUid(req);
        if (!firebaseUid) {
            return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
        }

        const { items, subtotal, tax, total, itemCount } = await req.json();

        if (!Array.isArray(items)) {
            return NextResponse.json({ success: false, error: 'Items must be an array' }, { status: 400 });
        }

        const cartRef = db.collection('carts').doc(firebaseUid);

        await cartRef.set({
            items,
            subtotal: subtotal || 0,
            tax: tax || 0,
            total: total || 0,
            itemCount: itemCount || 0,
            updatedAt: new Date().toISOString()
        }, { merge: true });

        const updatedDoc = await cartRef.get();

        return NextResponse.json({
            success: true,
            data: updatedDoc.data()
        });
    } catch (error) {
        console.error('Error updating cart:', error);
        return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 });
    }
}
