import { NextResponse } from 'next/server'
import { createClient } from '@sanity/client'

const sanityClient = createClient({
    projectId: process.env.NEXT_PUBLIC_SANITY_PROJECT_ID || process.env.SANITY_PROJECT_ID || '',
    dataset: process.env.NEXT_PUBLIC_SANITY_DATASET || process.env.SANITY_DATASET || 'production',
    apiVersion: '2024-01-01',
    useCdn: true,
})

// Fallback garment list used when Sanity has no garmentTemplate documents yet.
const FALLBACK_GARMENTS = [
    { id: 'tshirt',   label: 'T-Shirt',   frontImageUrl: null, backImageUrl: null, supportsCollarPocket: true,  sortOrder: 1 },
    { id: 'hoodie',   label: 'Hoodie',    frontImageUrl: null, backImageUrl: null, supportsCollarPocket: false, sortOrder: 2 },
    { id: 'polo',     label: 'Polo Shirt',frontImageUrl: null, backImageUrl: null, supportsCollarPocket: false, sortOrder: 3 },
    { id: 'cap',      label: 'Cap',       frontImageUrl: null, backImageUrl: null, supportsCollarPocket: false, sortOrder: 4 },
    { id: 'totebag',  label: 'Tote Bag',  frontImageUrl: null, backImageUrl: null, supportsCollarPocket: false, sortOrder: 5 },
]

export async function GET() {
    try {
        const query = `*[_type == "garmentTemplate"] | order(sortOrder asc) {
            id,
            label,
            "frontImageUrl": frontImage.asset->url,
            "backImageUrl":  backImage.asset->url,
            supportsCollarPocket,
            sortOrder
        }`

        const results = await sanityClient.fetch(query)

        // If CMS has no documents yet, return the hard-coded fallback so the app
        // works before an admin uploads garment artwork.
        const data = (Array.isArray(results) && results.length > 0)
            ? results
            : FALLBACK_GARMENTS

        return NextResponse.json({ success: true, data })
    } catch (err) {
        console.error('garments fetch error:', err)
        // Never fail the app — return the fallback on any Sanity error.
        return NextResponse.json({ success: true, data: FALLBACK_GARMENTS })
    }
}
