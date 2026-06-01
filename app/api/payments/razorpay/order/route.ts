import { NextResponse, NextRequest } from 'next/server';
import Razorpay from 'razorpay';
import { db } from '@/lib/config/database';
import * as admin from 'firebase-admin';

// Lazy init — avoids crash during `next build` when env vars are absent
function getRazorpay() {
    return new Razorpay({
        key_id: process.env.RAZORPAY_KEY_ID!,
        key_secret: process.env.RAZORPAY_KEY_SECRET!,
    });
}

// Extract uid from Bearer token
async function getFirebaseUid(req: NextRequest): Promise<string | null> {
    const authHeader = req.headers.get('authorization');
    if (!authHeader?.startsWith('Bearer ')) return null;

    try {
        const token = authHeader.split('Bearer ')[1];
        const decodedToken = await admin.auth().verifyIdToken(token);
        return decodedToken.uid;
    } catch {
        return null;
    }
}

export async function POST(req: NextRequest) {
    try {
        const firebaseUid = await getFirebaseUid(req);
        if (!firebaseUid) {
            return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
        }

        const { order_id } = await req.json();
        if (!order_id) {
            return NextResponse.json({ success: false, error: 'order_id is required' }, { status: 400 });
        }

        // Fetch the Firestore order to validate ownership and get amount
        const orderRef = db.collection('orders').doc(order_id);
        const orderSnap = await orderRef.get();

        if (!orderSnap.exists) {
            return NextResponse.json({ success: false, error: 'Order not found' }, { status: 404 });
        }

        const order = orderSnap.data();
        if (order?.firebaseUid !== firebaseUid) {
            return NextResponse.json({ success: false, error: 'Order not found' }, { status: 404 });
        }

        // Razorpay expects amount in paise (1 INR = 100 paise)
        const amountInPaise = Math.round(order?.totalAmount * 100);

        const razorpayOrder = await getRazorpay().orders.create({
            amount: amountInPaise,
            currency: 'INR',
            receipt: order_id,
            notes: {
                firestoreOrderId: order_id,
                firebaseUid: firebaseUid,
            },
        });

        // ✅ CRITICAL: Save razorpayOrderId back to Firestore so verify route can find the order
        await orderRef.update({
            razorpayOrderId: razorpayOrder.id,
            updatedAt: new Date().toISOString(),
        });

        console.log(`Saved razorpayOrderId ${razorpayOrder.id} to Firestore order ${order_id}`);

        return NextResponse.json({
            success: true,
            razorpay_order_id: razorpayOrder.id,
            amount: razorpayOrder.amount,
            currency: razorpayOrder.currency,
            key_id: process.env.RAZORPAY_KEY_ID,
        });

    } catch (error: any) {
        console.error('Razorpay order creation error:', error);
        return NextResponse.json({ success: false, error: error.message || 'Internal server error' }, { status: 500 });
    }
}
