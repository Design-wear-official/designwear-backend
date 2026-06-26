import { NextResponse, NextRequest } from 'next/server';
import { db } from '@/lib/config/database';

// Get products — returns `data` key matching Flutter Product.fromApiMap expectations
export async function GET(req: NextRequest) {
    try {
        const { searchParams } = new URL(req.url);
        const limitStr = searchParams.get('limit') || '50';
        const status = searchParams.get('status');

        let productsRef: FirebaseFirestore.Query<FirebaseFirestore.DocumentData> = db.collection('products');

        if (status) {
            productsRef = productsRef.where('status', '==', status);
        }

        productsRef = productsRef.orderBy('createdAt', 'desc').limit(Number(limitStr));

        const snapshot = await productsRef.get();
        const data: Record<string, unknown>[] = [];

        snapshot.forEach((doc) => {
            const d = doc.data();
            data.push({
                id: doc.id,
                // Normalize Firestore fields to match Product.fromApiMap
                title: d.title || d.name || '',
                slug: d.slug || '',
                description: d.description || '',
                price: d.price || 0,
                imageUrl: d.imageUrl || (Array.isArray(d.images) && d.images.length > 0 ? d.images[0]?.asset?._ref : null),
                previewImageUrl: d.previewImageUrl || null,
                backPreviewImageUrl: d.backPreviewImageUrl || null,
                categoryId: d.categoryId || d.category_id || null,
                stockStatus: d.stockStatus || (d.stock > 0 ? 'inStock' : 'outOfStock'),
                // Keep original fields for backwards compatibility
                ...d,
            });
        });

        return NextResponse.json({
            success: true,
            data,
            total: snapshot.size,
            limit: Number(limitStr)
        }, { status: 200 });
    } catch (error) {
        console.error('Error fetching products:', error);
        return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 });
    }
}

// Create product
export async function POST(req: NextRequest) {
    try {
        const { name, title, sku, price, stock, category_id, categoryId, description } = await req.json();
        const productTitle = title || name;

        if (!productTitle || !price) {
            return NextResponse.json({ success: false, error: 'Missing required fields: title/name and price' }, { status: 400 });
        }

        const newProductRef = db.collection('products').doc();

        const payload = {
            // Normalized fields for Flutter Product.fromApiMap
            title: productTitle,
            name: productTitle,
            slug: (productTitle as string).toLowerCase().replace(/\s+/g, '-'),
            sku: sku || '',
            price: Number(price),
            stock: stock || 0,
            categoryId: categoryId || category_id || null,
            category_id: categoryId || category_id || null,
            description: description || '',
            status: 'active',
            stockStatus: (stock || 0) > 0 ? 'inStock' : 'outOfStock',
            syncedToDb: false,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };

        await newProductRef.set(payload);
        const savedSnap = await newProductRef.get();

        return NextResponse.json({
            success: true,
            data: { id: newProductRef.id, ...savedSnap.data() }
        }, { status: 201 });
    } catch (error) {
        console.error('Error creating product:', error);
        return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 });
    }
}
