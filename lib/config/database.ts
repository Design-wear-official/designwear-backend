import { initializeApp, getApps, cert, ServiceAccount } from 'firebase-admin/app';
import { getFirestore, Firestore } from 'firebase-admin/firestore';
import { getAuth, Auth } from 'firebase-admin/auth';
import { getMessaging, Messaging } from 'firebase-admin/messaging';
import { logger } from '../utils/logger';

const FIREBASE_PROJECT_ID =
    process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ||
    process.env.FIREBASE_PROJECT_ID ||
    'designwear-731c9';

export let firebaseReady = false;

function initializeFirebaseAdmin() {
    if (getApps().length) return;

    const serviceAccountKey = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;

    if (!serviceAccountKey) {
        logger.error(
            'FIREBASE_SERVICE_ACCOUNT_KEY is not set. ' +
            'Add it to Vercel Environment Variables (Project Settings → Environment Variables). ' +
            'Get it from Firebase Console → Project Settings → Service Accounts → Generate new private key.'
        );
        firebaseReady = false;
        return;
    }

    try {
        let parsedKey = serviceAccountKey.trim();

        if (parsedKey.startsWith("'") && parsedKey.endsWith("'")) {
            parsedKey = parsedKey.slice(1, -1);
        }
        if (parsedKey.startsWith('"') && parsedKey.endsWith('"')) {
            parsedKey = parsedKey.slice(1, -1);
        }

        let serviceAccount: Record<string, unknown>;
        try {
            serviceAccount = JSON.parse(parsedKey);
        } catch {
            const escaped = parsedKey
                .replace(/\r\n/g, '\\n')
                .replace(/\r/g, '\\n')
                .replace(/\n/g, '\\n');
            serviceAccount = JSON.parse(escaped);
        }

        if (serviceAccount.private_key && typeof serviceAccount.private_key === 'string') {
            serviceAccount.private_key = (serviceAccount.private_key as string).replace(/\\n/g, '\n');
        }

        initializeApp({
            credential: cert(serviceAccount as ServiceAccount),
            projectId: (serviceAccount.project_id as string) || FIREBASE_PROJECT_ID,
        });

        firebaseReady = true;
        logger.info('Firebase Admin initialized successfully');
    } catch (e) {
        logger.error('Failed to initialize Firebase Admin — check FIREBASE_SERVICE_ACCOUNT_KEY format:', e);
        firebaseReady = false;
    }
}

initializeFirebaseAdmin();

function getDb(): Firestore {
    if (!firebaseReady) {
        throw new Error(
            'Firebase Admin is not initialized. ' +
            'Set FIREBASE_SERVICE_ACCOUNT_KEY in Vercel Environment Variables and redeploy.'
        );
    }
    return getFirestore();
}

function getAdminAuth(): Auth {
    if (!firebaseReady) {
        throw new Error(
            'Firebase Admin is not initialized. ' +
            'Set FIREBASE_SERVICE_ACCOUNT_KEY in Vercel Environment Variables and redeploy.'
        );
    }
    return getAuth();
}

function getAdminMessaging(): Messaging {
    if (!firebaseReady) {
        throw new Error(
            'Firebase Admin is not initialized. ' +
            'Set FIREBASE_SERVICE_ACCOUNT_KEY in Vercel Environment Variables and redeploy.'
        );
    }
    return getMessaging();
}

export const db = new Proxy({} as Firestore, {
    get(_target, prop) {
        const firestore = getDb();
        const value = (firestore as unknown as Record<string | symbol, unknown>)[prop];
        return typeof value === 'function' ? value.bind(firestore) : value;
    },
});

export const auth = new Proxy({} as Auth, {
    get(_target, prop) {
        const adminAuth = getAdminAuth();
        const value = (adminAuth as unknown as Record<string | symbol, unknown>)[prop];
        return typeof value === 'function' ? value.bind(adminAuth) : value;
    },
});

export const messaging = new Proxy({} as Messaging, {
    get(_target, prop) {
        const adminMessaging = getAdminMessaging();
        const value = (adminMessaging as unknown as Record<string | symbol, unknown>)[prop];
        return typeof value === 'function' ? value.bind(adminMessaging) : value;
    },
});

export async function connectDatabase(): Promise<void> {
    logger.info('Firestore Database connected');
}

export async function closeDatabaseConnection(): Promise<void> {
    logger.info('Database pool closed (No-op for Firestore)');
}
