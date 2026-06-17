import { NextResponse, NextRequest } from 'next/server';

const apiKey = process.env.GEMINI_API_KEY;
const MODEL_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image:generateContent';

export async function POST(req: NextRequest) {
    try {
        if (!apiKey) {
            return NextResponse.json({ success: false, error: 'Gemini AI is not configured on the server.' }, { status: 503 });
        }

        const body = await req.json();
        const { personImageBase64, clothingImageBase64 } = body;

        if (!personImageBase64 || !clothingImageBase64) {
            return NextResponse.json({ success: false, error: 'Missing personImageBase64 or clothingImageBase64' }, { status: 400 });
        }

        const requestBody = {
            contents: [
                {
                    parts: [
                        {
                            text: `You are a professional fashion photographer and digital artist. 
                
Your task: Generate a hyper-realistic image of the person from the first image wearing the clothing item from the second image.

CRITICAL INSTRUCTIONS:
1.  **Photorealism**: The output MUST look like a real photograph, not a drawing or 3D render.
2.  **Preserve Identity**: Keep the person's face, hair, body shape, and pose EXACTLY as they are in the original photo.
3.  **Preserve Background**: Do not change the background.
4.  **Clothing Fit**: The new clothing item must wrap naturally around the person's body, respecting gravity, folds, and shadows.
5.  **Lighting**: Match the lighting on the clothing to the lighting in the original photo of the person.
6.  **Integration**: Ensure seamless blending at the neck, arms, and waist.

Input 1: Image of a person.
Input 2: Image of a clothing item.

Output: A single high-quality image of the person wearing the clothing item.`
                        },
                        { inlineData: { mimeType: 'image/jpeg', data: personImageBase64 } },
                        { inlineData: { mimeType: 'image/jpeg', data: clothingImageBase64 } }
                    ]
                }
            ],
            generationConfig: {
                responseModalities: ["image"],
                temperature: 0.3,
                topK: 40,
                topP: 0.95
            }
        };

        const response = await fetch(`${MODEL_URL}?key=${apiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody)
        });

        const data = await response.json();

        if (!response.ok) {
            const errMsg: string = data.error?.message || 'Gemini API Error';
            const userMsg = errMsg.includes('quota') || errMsg.includes('RESOURCE_EXHAUSTED')
                ? 'Virtual Try-On requires a paid Gemini API plan. Enable billing at aistudio.google.com and ensure your GEMINI_API_KEY has access to gemini-3.1-flash-image.'
                : errMsg;
            return NextResponse.json({ success: false, error: userMsg }, { status: response.status });
        }

        const candidates = data.candidates || [];
        if (candidates.length > 0) {
            const parts = candidates[0].content?.parts || [];
            for (const part of parts) {
                if (part.inlineData && part.inlineData.data) {
                    return NextResponse.json({
                        success: true,
                        generateImageBase64: part.inlineData.data
                    });
                }
            }
        }

        return NextResponse.json({ success: false, error: 'No image returned from Gemini' }, { status: 500 });
    } catch (error: unknown) {
        console.error('Error generating AI try-on:', error);
        const errorMessage = error instanceof Error ? error.message : 'Internal server error';
        return NextResponse.json({ success: false, error: errorMessage }, { status: 500 });
    }
}
