import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@sanity/client'
import { db, firebaseReady } from '@/lib/config/database'

const sanityClient = createClient({
    projectId: process.env.NEXT_PUBLIC_SANITY_PROJECT_ID || process.env.SANITY_PROJECT_ID || '',
    dataset: process.env.NEXT_PUBLIC_SANITY_DATASET || process.env.SANITY_DATASET || 'production',
    apiVersion: '2024-01-01',
    token: process.env.SANITY_API_TOKEN,
    useCdn: false,
})

export async function POST(req: NextRequest) {
    try {
        const body = await req.json()
        const {
            title,
            garmentType = 'tshirt',
            garmentBaseColor,
            artText,
            creatorName,
            creatorHandle,
            remixedFromId,
            remixedFromHandle,
            remixedFromVersion,
            lineage = [],
            tags = [],
        } = body

        if (!creatorHandle) {
            return NextResponse.json({ error: 'creatorHandle is required' }, { status: 400 })
        }

        const cleanHandle = (creatorHandle as string).replace(/^@/, '')
        const slug = `${cleanHandle}-remix-${Date.now()}`
        const sku = `REMIX-${Date.now()}`
        const designName = (title as string)?.trim() || `Remix by ${creatorHandle}`

        // 1. Create Sanity document (lands as draft)
        const draft = await sanityClient.create({
            _type: 'product',
            name: designName,
            slug: { _type: 'slug', current: slug },
            description: remixedFromHandle
                ? `Remixed from ${remixedFromHandle}${remixedFromVersion ? ` (${remixedFromVersion})` : ''}`
                : 'Community remix design',
            sku,
            price: 0,
            stock: 0,
            status: 'active',
            featured: false,
            garmentType,
            garmentBaseColor: garmentBaseColor || null,
            artText: artText || null,
            creatorName: creatorName || null,
            creatorHandle,
            remixedFromHandle: remixedFromHandle || null,
            remixedFromVersion: remixedFromVersion || null,
            lineage,
            likeCount: 0,
            remixCount: 0,
            tags,
        })

        // 2. Publish: move from drafts.* → published document
        const publishedId = draft._id.replace(/^drafts\./, '')
        await sanityClient
            .transaction()
            .createOrReplace({ ...draft, _id: publishedId })
            .delete(draft._id)
            .commit()

        // 3. Increment parent remixCount (non-fatal)
        if (remixedFromId) {
            await sanityClient
                .patch(remixedFromId as string)
                .inc({ remixCount: 1 })
                .commit()
                .catch((e) => console.warn('remixCount increment failed (non-fatal):', e))
        }

        // 4. Sync to Firestore
        let firebaseSynced = false
        if (firebaseReady) {
            try {
                await db.collection('products').doc(publishedId).set({
                    sanityId: publishedId,
                    name: designName,
                    title: designName,
                    slug,
                    sku,
                    price: 0,
                    stock: 0,
                    stockStatus: 'inStock',
                    status: 'active',
                    featured: false,
                    garmentType,
                    garmentBaseColor: garmentBaseColor || null,
                    artText: artText || null,
                    creatorName: creatorName || null,
                    creatorHandle,
                    creatorFollowerCount: 0,
                    remixedFromHandle: remixedFromHandle || null,
                    remixedFromVersion: remixedFromVersion || null,
                    lineage,
                    likeCount: 0,
                    remixCount: 0,
                    tags,
                    syncedToDb: true,
                    syncedAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                }, { merge: true })
                firebaseSynced = true
            } catch (fbErr) {
                console.error('Firebase sync failed (non-fatal):', fbErr)
            }
        }

        return NextResponse.json({ success: true, productId: publishedId, slug, firebaseSynced })
    } catch (err: unknown) {
        console.error('publish-remix error:', err)
        return NextResponse.json(
            { error: err instanceof Error ? err.message : 'Publish failed' },
            { status: 500 },
        )
    }
}
