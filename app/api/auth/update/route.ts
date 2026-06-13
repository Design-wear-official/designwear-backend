import { NextResponse, NextRequest } from 'next/server';
import { db, auth } from '@/lib/config/database';
import { syncCustomerToSanity } from '@/lib/services/syncService';

export async function POST(req: NextRequest) {
    try {
        const body = await req.json();
        const { uid, name, email, photoUrl, addresses, paymentMethods, fcmToken } = body;

        if (!uid) {
            return NextResponse.json({ success: false, error: 'User ID is required' }, { status: 400 });
        }

        const updateData: any = {};
        if (name !== undefined) updateData.name = name;
        if (email !== undefined) updateData.email = email;
        if (photoUrl !== undefined) updateData.photoUrl = photoUrl;
        if (addresses !== undefined) updateData.addresses = addresses;
        if (paymentMethods !== undefined) updateData.paymentMethods = paymentMethods;
        if (fcmToken !== undefined) updateData.fcmToken = fcmToken;

        updateData.updatedAt = new Date().toISOString();

        // 1. Update Custom User Profile Document inside Firestore
        await db.collection('customers').doc(uid).set(updateData, { merge: true });

        // 2. Update User in Firebase Auth if applicable
        if (name || email || photoUrl) {
           const authUpdate: any = {};
           if (name) authUpdate.displayName = name;
           if (email) authUpdate.email = email;
           if (photoUrl) authUpdate.photoURL = photoUrl;
           
           try {
             await auth.updateUser(uid, authUpdate);
           } catch (authErr) {
             console.warn('Failed to update Firebase Auth user (could be a guest or non-existent auth record):', authErr);
           }
         }
 
         // 3. Sync updated data to Sanity Studio
         const fullUserDoc = await db.collection('customers').doc(uid).get();
         if (fullUserDoc.exists) {
            await syncCustomerToSanity(uid, fullUserDoc.data());
         }

         return NextResponse.json({
            success: true,
            data: {
                uid,
                ...updateData
            }
        });
    } catch (error: unknown) {
        console.error('Error in /api/auth/update:', error);
        const errorMessage = error instanceof Error ? error.message : 'Update failed';
        return NextResponse.json({ success: false, error: errorMessage }, { status: 500 });
    }
}
