import { createClient } from '@sanity/client';
import { db } from '../config/database';
import { logger } from '../utils/logger';

const client = createClient({
    projectId: process.env.NEXT_PUBLIC_SANITY_PROJECT_ID || process.env.SANITY_PROJECT_ID || '',
    dataset: process.env.NEXT_PUBLIC_SANITY_DATASET || process.env.SANITY_DATASET || 'production',
    apiVersion: '2024-01-01',
    token: process.env.SANITY_API_TOKEN,
    useCdn: false,
});

interface SyncResult {
    success: boolean;
    message: string;
}

export async function checkDocumentExists(sanityDocumentId: string): Promise<boolean> {
    try {
        const count = await client.fetch(`count(*[_id == $id])`, { id: sanityDocumentId });
        return count > 0;
    } catch (error) {
        logger.error(`Error checking document existence for ${sanityDocumentId}:`, error);
        return false;
    }
}

export async function syncProductToDatabase(sanityDocumentId: string): Promise<SyncResult> {
    try {
        const product = await client.fetch(
            `*[_type == "product" && _id == $id][0]{
        _id,
        name,
        slug,
        description,
        sku,
        price,
        compareAtPrice,
        stock,
        lowStockThreshold,
        status,
        featured,
        "categoryId": category->_id,
        "categorySlug": category->slug.current,
        "supplierId": supplier->_id,
        sizes,
        colors,
        "imageUrl": images[0].asset->url,
        "images": images[].asset->url
      }`,
            { id: sanityDocumentId }
        );

        if (!product) {
            throw new Error(`Product ${sanityDocumentId} not found in Sanity`);
        }

        const productRef = db.collection('products').doc(sanityDocumentId);

        await productRef.set({
            sanityId: sanityDocumentId,
            // Original Sanity fields
            name: product.name,
            slug: product.slug?.current || '',
            description: product.description || '',
            sku: product.sku || '',
            price: product.price || 0,
            compareAtPrice: product.compareAtPrice || null,
            stock: product.stock || 0,
            lowStockThreshold: product.lowStockThreshold || 0,
            status: product.status || 'draft',
            featured: product.featured || false,
            categoryId: product.categoryId || null,
            category_id: product.categoryId || null,
            supplierId: product.supplierId || null,
            sizes: product.sizes || [],
            colors: product.colors || [],
            images: product.images || [],
            // Normalized fields for Flutter Product.fromApiMap compatibility
            title: product.name,
            imageUrl: product.imageUrl || null,
            images: product.images || [],
            availableSizes: product.sizes || [],
            availableColors: product.colors || [],
            stockStatus: (product.stock || 0) > 0 ? 'inStock' : 'outOfStock',
            syncedToDb: true,
            syncedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        }, { merge: true });

        logger.info(`Upserted product ${sanityDocumentId} into Firestore db`);

        await logOperation('sync', 'product', sanityDocumentId, null);
        return { success: true, message: `Product ${sanityDocumentId} synced successfully` };
    } catch (error: unknown) {
        logger.error(`Failed to sync product ${sanityDocumentId}:`, error);
        await logOperation('sync', 'product', sanityDocumentId, error);
        const errorMessage = error instanceof Error ? error.message : `Failed to sync product ${sanityDocumentId}`;
        return { success: false, message: errorMessage };
    }
}

/**
 * Syncs a customer profile from Firestore/Firebase to Sanity Studio.
 * Uses the firebaseUid to identify and upsert the document in Sanity.
 */
export async function syncCustomerToSanity(uid: string, data: any): Promise<SyncResult> {
    try {
        const sanityDocId = `customer-${uid}`;
        
        const customerDoc = {
            _type: 'customer',
            _id: sanityDocId,
            name: data.name || 'Unknown User',
            email: data.email || '',
            phone: data.phone || '',
            addresses: data.addresses || [],
            totalOrders: data.totalOrders || 0,
            totalSpent: data.totalSpent || 0,
            registeredAt: data.createdAt || new Date().toISOString(),
        };

        await client.createOrReplace(customerDoc);
        
        logger.info(`Synced customer ${uid} to Sanity with ID ${sanityDocId}`);
        return { success: true, message: `Customer ${uid} synced to Sanity` };
    } catch (error: unknown) {
        logger.error(`Failed to sync customer ${uid} to Sanity:`, error);
        const errorMessage = error instanceof Error ? error.message : `Failed to sync customer ${uid} to Sanity`;
        return { success: false, message: errorMessage };
    }
}

async function logOperation(
    operationType: string,
    documentType: string,
    documentId: string,
    error: unknown
): Promise<void> {
    try {
        await db.collection('operationLogs').add({
            operationType,
            documentType,
            documentId,
            error: error instanceof Error ? error.message : String(error),
            createdAt: new Date().toISOString()
        });
    } catch (err) {
        logger.error('Failed to log operation:', err);
    }
}
