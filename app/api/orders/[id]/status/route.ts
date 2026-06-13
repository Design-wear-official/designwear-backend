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

export async function PATCH(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const { id } = await params;
        const firebaseUid = await getFirebaseUid(req);
        if (!firebaseUid) {
            return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
        }

        const orderId = id;
        const { status } = await req.json();

        if (!status) {
            return NextResponse.json({ success: false, error: 'Status is required' }, { status: 400 });
        }

        const orderRef = db.collection('orders').doc(orderId);
        const orderSnap = await orderRef.get();

        if (!orderSnap.exists) {
            return NextResponse.json({ success: false, error: 'Order not found' }, { status: 404 });
        }

        if (orderSnap.data()?.firebaseUid !== firebaseUid) {
            return NextResponse.json({ success: false, error: 'Unauthorized order mutation' }, { status: 401 });
        }

        await orderRef.set({ status, updatedAt: new Date().toISOString() }, { merge: true });

        const updatedOrder = await orderRef.get();

        return NextResponse.json({
            success: true,
            data: { id: updatedOrder.id, ...updatedOrder.data() }
        });
    } catch (error) {
        console.error('Error updating order:', error);
        return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 });
    }
}
