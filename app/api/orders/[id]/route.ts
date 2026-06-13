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

// Get single order
export async function GET(
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
        const orderRef = db.collection('orders').doc(orderId);
        const orderSnap = await orderRef.get();

        if (!orderSnap.exists) {
            return NextResponse.json({ success: false, error: 'Order not found' }, { status: 404 });
        }

        const orderData = orderSnap.data();

        if (orderData?.firebaseUid !== firebaseUid) {
            return NextResponse.json({ success: false, error: 'Unauthorized order access' }, { status: 401 });
        }

        return NextResponse.json({
            success: true,
            data: { id: orderSnap.id, ...orderData }
        });
    } catch (error) {
        console.error('Error fetching order:', error);
        return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 });
    }
}
