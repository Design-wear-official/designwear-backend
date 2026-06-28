import { NextResponse, NextRequest } from 'next/server';
import { randomUUID } from 'crypto';
import { db, auth, getBucket } from '@/lib/config/database';

const MAX_BYTES = 2 * 1024 * 1024; // 2 MB
const MAX_STICKERS = 50;

// Extract uid from Bearer token
async function getFirebaseUid(req: NextRequest): Promise<string | null> {
    const authHeader = req.headers.get('authorization');
    if (!authHeader?.startsWith('Bearer ')) return null;
    try {
        const token = authHeader.split('Bearer ')[1];
        const decoded = await auth.verifyIdToken(token);
        return decoded.uid;
    } catch {
        return null;
    }
}

/**
 * Sniff the real image type from magic bytes. Returns null for anything that is
 * not an allowed raster image — this is the server half of the malicious-upload
 * block (extension/MIME claims from the client are ignored). SVG is rejected on
 * purpose: it can carry scripts (stored XSS).
 */
function sniffImage(buf: Buffer): { ext: string; contentType: string } | null {
    if (buf.length < 12) return null;
    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
        return { ext: 'png', contentType: 'image/png' };
    }
    // JPEG: FF D8 FF
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
        return { ext: 'jpg', contentType: 'image/jpeg' };
    }
    // GIF: 47 49 46 38 (GIF8)
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) {
        return { ext: 'gif', contentType: 'image/gif' };
    }
    // WebP: "RIFF" .... "WEBP"
    if (
        buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
        buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
    ) {
        return { ext: 'webp', contentType: 'image/webp' };
    }
    return null;
}

type StickerMeta = { id: string; url: string; contentType: string; createdAt: string };

async function readList(uid: string): Promise<StickerMeta[]> {
    const doc = await db.collection('userStickers').doc(uid).get();
    return doc.exists ? ((doc.data()?.stickers as StickerMeta[]) ?? []) : [];
}

// List the user's custom stickers (most-recent first)
export async function GET(req: NextRequest) {
    try {
        const uid = await getFirebaseUid(req);
        if (!uid) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
        return NextResponse.json({ success: true, data: { stickers: await readList(uid) } });
    } catch (error) {
        console.error('Error listing stickers:', error);
        return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 });
    }
}

// Upload a new custom sticker. Body: { imageBase64: string }
export async function POST(req: NextRequest) {
    try {
        const uid = await getFirebaseUid(req);
        if (!uid) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });

        const body = await req.json().catch(() => null);
        const imageBase64: unknown = body?.imageBase64;
        if (typeof imageBase64 !== 'string' || imageBase64.length === 0) {
            return NextResponse.json({ success: false, error: 'imageBase64 is required' }, { status: 400 });
        }

        // Accept optional data-URL prefix but validate the bytes themselves.
        const raw = imageBase64.includes(',') ? imageBase64.split(',').pop()! : imageBase64;
        let buffer: Buffer;
        try {
            buffer = Buffer.from(raw, 'base64');
        } catch {
            return NextResponse.json({ success: false, error: 'Invalid base64' }, { status: 400 });
        }

        if (buffer.length === 0 || buffer.length > MAX_BYTES) {
            return NextResponse.json(
                { success: false, error: `Image must be between 1 byte and ${MAX_BYTES} bytes` },
                { status: 400 },
            );
        }

        const kind = sniffImage(buffer);
        if (!kind) {
            return NextResponse.json(
                { success: false, error: 'Unsupported or unsafe file. Allowed: PNG, JPEG, WebP, GIF.' },
                { status: 415 },
            );
        }

        const list = await readList(uid);
        if (list.length >= MAX_STICKERS) {
            return NextResponse.json(
                { success: false, error: `Sticker limit reached (${MAX_STICKERS}). Delete some first.` },
                { status: 409 },
            );
        }

        const id = randomUUID();
        const downloadToken = randomUUID();
        const path = `userStickers/${uid}/${id}.${kind.ext}`;
        const bucket = getBucket();

        await bucket.file(path).save(buffer, {
            resumable: false,
            contentType: kind.contentType,
            metadata: {
                contentType: kind.contentType,
                cacheControl: 'public, max-age=31536000, immutable',
                metadata: { firebaseStorageDownloadTokens: downloadToken, owner: uid },
            },
        });

        const url =
            `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/` +
            `${encodeURIComponent(path)}?alt=media&token=${downloadToken}`;

        const meta: StickerMeta = { id, url, contentType: kind.contentType, createdAt: new Date().toISOString() };
        const updated = [meta, ...list].slice(0, MAX_STICKERS);
        await db.collection('userStickers').doc(uid).set(
            { stickers: updated, updatedAt: new Date().toISOString() },
            { merge: true },
        );

        return NextResponse.json({ success: true, data: meta });
    } catch (error) {
        console.error('Error uploading sticker:', error);
        return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 });
    }
}

// Delete a sticker by id: /api/user/stickers?id=<id>
export async function DELETE(req: NextRequest) {
    try {
        const uid = await getFirebaseUid(req);
        if (!uid) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });

        const id = req.nextUrl.searchParams.get('id');
        if (!id) return NextResponse.json({ success: false, error: 'id is required' }, { status: 400 });

        const list = await readList(uid);
        const target = list.find((s) => s.id === id);
        if (target) {
            const ext = target.contentType.split('/').pop()?.replace('jpeg', 'jpg') ?? 'png';
            await getBucket().file(`userStickers/${uid}/${id}.${ext}`).delete({ ignoreNotFound: true });
        }

        const updated = list.filter((s) => s.id !== id);
        await db.collection('userStickers').doc(uid).set(
            { stickers: updated, updatedAt: new Date().toISOString() },
            { merge: true },
        );

        return NextResponse.json({ success: true, data: { stickers: updated } });
    } catch (error) {
        console.error('Error deleting sticker:', error);
        return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 });
    }
}
