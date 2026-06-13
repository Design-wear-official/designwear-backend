import { NextResponse } from 'next/server';
import { db, auth } from '@/lib/config/database';
import { syncCustomerToSanity } from '@/lib/services/syncService';

export async function POST() {
    try {
        // 1. Create completely anonymous account securely using the elevated Admin SDK privileges
        const userRecord = await auth.createUser({});
        const guestUid = userRecord.uid;

        // 2. Generate a custom session token for the frontend to digest
        const customToken = await auth.createCustomToken(guestUid);

        // 3. Exchange custom token for ID token using REST API (ID token is verifiable by backend)
        const apiKey = process.env.FIREBASE_API_KEY;
        if (!apiKey) {
            throw new Error("Missing FIREBASE_API_KEY in backend configuration");
        }

        const idTokenResponse = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${apiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                token: customToken,
                returnSecureToken: true
            })
        });

        const idTokenData = await idTokenResponse.json();
        if (!idTokenResponse.ok) {
            throw new Error(idTokenData.error?.message || 'Failed to exchange custom token for ID token');
        }

        await db.collection('customers').doc(guestUid).set({
            firebaseUid: guestUid,
            name: 'Guest User',
            email: '',
            isGuest: true,
            createdAt: new Date().toISOString()
        }, { merge: true });

        // 4. Sync guest to Sanity Studio
        const guestData = {
            firebaseUid: guestUid,
            name: 'Guest User',
            email: '',
            isGuest: true,
            createdAt: new Date().toISOString()
        };
        await syncCustomerToSanity(guestUid, guestData);

        // 5. Return the ID token directly to the frontend
        return NextResponse.json({
            success: true,
            data: {
                token: idTokenData.idToken,           // Verifiable ID token
                uid: guestUid,
                isGuest: true,
                addresses: [],
                paymentMethods: []
            }
        });
    } catch (error: unknown) {
        console.error('Error in /api/auth/guest:', error);
        const errorMessage = error instanceof Error ? error.message : 'Guest login failed';
        return NextResponse.json({ success: false, error: errorMessage }, { status: 500 });
    }
}
