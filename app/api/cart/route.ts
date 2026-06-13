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

// Get cart
export async function GET(req: NextRequest) {
    try {
        const firebaseUid = await getFirebaseUid(req);
        if (!firebaseUid) {
            return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
        }

        const cartDoc = await db.collection('carts').doc(firebaseUid).get();

        if (!cartDoc.exists) {
            return NextResponse.json({
                success: true,
                data: {
                    items: [],
                    subtotal: 0,
                    tax: 0,
                    total: 0,
                    itemCount: 0
                }
            });
        }

        return NextResponse.json({ success: true, data: cartDoc.data() });
    } catch (error) {
        console.error('Error fetching cart:', error);
        return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 });
    }
}

// Clear cart
export async function DELETE(req: NextRequest) {
    try {
        const firebaseUid = await getFirebaseUid(req);
        if (!firebaseUid) {
            return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
        }

        await db.collection('carts').doc(firebaseUid).set({
            items: [],
            subtotal: 0,
            tax: 0,
            total: 0,
            itemCount: 0,
            updatedAt: new Date().toISOString()
        }, { merge: true });

        return NextResponse.json({
            success: true,
            data: { message: 'Cart cleared successfully' }
        });
    } catch (error) {
        console.error('Error clearing cart:', error);
        return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 });
    }
}
