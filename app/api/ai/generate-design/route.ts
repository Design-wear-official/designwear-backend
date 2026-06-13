import { NextResponse, NextRequest } from 'next/server';

const apiKey = process.env.GEMINI_API_KEY;
const IMAGE_MODEL_URL =
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent';

export async function POST(req: NextRequest) {
    try {
        if (!apiKey) {
            return NextResponse.json(
                { success: false, error: 'Gemini API key is missing' },
                { status: 503 }
            );
        }

        const body = await req.json();
        const { prompt } = body;

        if (!prompt) {
            return NextResponse.json(
                { success: false, error: 'prompt is required' },
                { status: 400 }
            );
        }

        const designPrompt =
            `Create a flat, bold t-shirt graphic print design for the theme: "${prompt}". ` +
            `Requirements: transparent or white background, no t-shirt outline, ` +
            `centered composition, vibrant colors, suitable for screen printing, ` +
            `square format. Style: modern streetwear graphic art.`;

        const requestBody = {
            contents: [{ role: 'user', parts: [{ text: designPrompt }] }],
            generationConfig: { responseModalities: ['IMAGE'] },
        };

        const response = await fetch(`${IMAGE_MODEL_URL}?key=${apiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody),
        });

        const data = await response.json();

        if (!response.ok) {
            return NextResponse.json(
                { success: false, error: data.error?.message || 'Image generation failed' },
                { status: response.status }
            );
        }

        const parts = data.candidates?.[0]?.content?.parts as Array<{
            inlineData?: { mimeType: string; data: string };
        }> | undefined;
        const imagePart = parts?.find((p) => p.inlineData);

        if (!imagePart?.inlineData) {
            return NextResponse.json(
                { success: false, error: 'No image returned from model' },
                { status: 500 }
            );
        }

        return NextResponse.json({
            success: true,
            imageData: imagePart.inlineData.data,
            mimeType: imagePart.inlineData.mimeType || 'image/png',
        });
    } catch (error: unknown) {
        console.error('generate-design error:', error);
        return NextResponse.json(
            { success: false, error: 'Internal Server Error' },
            { status: 500 }
        );
    }
}
