import { DocumentActionComponent, DocumentActionProps } from 'sanity'
import { useToast } from '@sanity/ui'

export function PublishAndSync(originalPublishAction: DocumentActionComponent): DocumentActionComponent {
    const CustomPublishAndSync = (props: DocumentActionProps) => {
        const originalResult = originalPublishAction(props)
        const toast = useToast()

        if (!originalResult) return null

        return {
            ...originalResult,
            label: 'Publish & Sync',
            onHandle: () => {
                // Execute sanity's native publish handler
                if (originalResult.onHandle) {
                    originalResult.onHandle()
                }

                // Since publish takes a moment to hit the Sanity DB, we'll delay the webhook trigger slightly
                setTimeout(async () => {
                    try {
                        const baseUrl = window.location.origin
                        const response = await fetch(`${baseUrl}/api/sync/trigger`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                documentType: props.type,
                                documentId: props.id.replace('drafts.', ''),
                            }),
                        })

                        if (!response.ok) {
                            const errorData = await response.json().catch(() => ({}))
                            toast.push({
                                title: 'Firebase Sync Error',
                                description: errorData.error || errorData.message || 'Failed to sync with Firebase',
                                status: 'error',
                            })
                            console.error('Sync failed:', errorData)
                        } else {
                            toast.push({
                                title: 'Firebase Sync Success',
                                description: `Product synced successfully.`,
                                status: 'success',
                            })
                        }
                    } catch (error) {
                        toast.push({
                            title: 'Webhook Network Error',
                            description: 'Failed to reach the custom sync webhook',
                            status: 'error',
                        })
                        console.error('Trigger webhook error:', error)
                    }
                }, 2000)
            },
        }
    }

    CustomPublishAndSync.action = 'publish'
    return CustomPublishAndSync as DocumentActionComponent
}
