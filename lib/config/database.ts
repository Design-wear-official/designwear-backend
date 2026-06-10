import * as admin from 'firebase-admin';
import { logger } from '../utils/logger';

const FIREBASE_PROJECT_ID =
    process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ||
    process.env.FIREBASE_PROJECT_ID ||
    'designwear-731c9';

// Track whether Firebase Admin was initialized with real credentials
export let firebaseReady = false;

function initializeFirebaseAdmin() {
    if (admin.apps.length) return;

    const serviceAccountKey = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;

    if (!serviceAccountKey) {
        logger.error(
            'FIREBASE_SERVICE_ACCOUNT_KEY is not set. ' +
            'Add it to Vercel Environment Variables (Project Settings → Environment Variables). ' +
            'Get it from Firebase Console → Project Settings → Service Accounts → Generate new private key.'
        );
        // Do NOT call initializeApp without credentials — it silently uses ADC which hangs on Vercel.
        firebaseReady = false;
        return;
    }

    try {
        let parsedKey = serviceAccountKey.trim();

        // Strip outer single-quotes (local .env.local format)
        if (parsedKey.startsWith("'") && parsedKey.endsWith("'")) {
            parsedKey = parsedKey.slice(1, -1);
        }
        // Strip outer double-quotes (Vercel sometimes wraps values)
        if (parsedKey.startsWith('"') && parsedKey.endsWith('"')) {
            parsedKey = parsedKey.slice(1, -1);
        }

        let serviceAccount: Record<string, unknown>;
        try {
            serviceAccount = JSON.parse(parsedKey);
        } catch {
            // Fallback: value was pasted with raw newlines instead of \n escape sequences
            const escaped = parsedKey
                .replace(/\r\n/g, '\\n')
                .replace(/\r/g, '\\n')
                .replace(/\n/g, '\\n');
            serviceAccount = JSON.parse(escaped);
        }

        // dotenv gives literal \n (2 chars); Firebase Admin needs actual newline chars in the PEM
        if (serviceAccount.private_key && typeof serviceAccount.private_key === 'string') {
            serviceAccount.private_key = (serviceAccount.private_key as string).replace(/\\n/g, '\n');
        }

        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount as admin.ServiceAccount),
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

// Lazy Firestore accessor — throws a clear 503 error instead of hanging when credentials are missing
function getDb(): admin.firestore.Firestore {
    if (!firebaseReady) {
        throw new Error(
            'Firebase Admin is not initialized. ' +
            'Set FIREBASE_SERVICE_ACCOUNT_KEY in Vercel Environment Variables and redeploy.'
        );
    }
    return admin.firestore();
}

// Proxy that forwards property access to the real Firestore instance (or throws fast)
export const db = new Proxy({} as admin.firestore.Firestore, {
    get(_target, prop) {
        const firestore = getDb();
        const value = (firestore as unknown as Record<string | symbol, unknown>)[prop];
        return typeof value === 'function' ? value.bind(firestore) : value;
    },
});

export async function connectDatabase(): Promise<void> {
    logger.info('Firestore Database connected');
}

export async function closeDatabaseConnection(): Promise<void> {
    logger.info('Database pool closed (No-op for Firestore)');
}
