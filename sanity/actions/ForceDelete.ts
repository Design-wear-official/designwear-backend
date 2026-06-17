'use client'

import { useCallback, useState } from 'react'
import { TrashIcon, WarningOutlineIcon } from '@sanity/icons'
import { Box, Button, Card, Flex, Spinner, Stack, Text } from '@sanity/ui'
import {
    DocumentActionComponent,
    DocumentActionProps,
    useClient,
    useDocumentOperation,
} from 'sanity'

/**
 * ForceDelete — replaces the default delete action with one that:
 * 1. Finds all documents that reference the target via GROQ
 * 2. Patches those documents to remove the reference field(s)
 * 3. Deletes the target document (and its draft)
 *
 * This avoids the "cannot be deleted as there are references" error.
 */
export function ForceDelete(
    originalDeleteAction: DocumentActionComponent,
): DocumentActionComponent {
    const ForceDeleteAction = (props: DocumentActionProps) => {
        const { id, type, onComplete } = props
        const client = useClient({ apiVersion: '2026-03-01' })
        const { delete: deleteOp } = useDocumentOperation(id, type)

        const [isDeleting, setIsDeleting] = useState(false)
        const [showDialog, setShowDialog] = useState(false)
        const [error, setError] = useState<string | null>(null)

        const handleDelete = useCallback(async () => {
            setIsDeleting(true)
            setError(null)

            try {
                // 1. Find all published documents that reference this doc
                const referencingDocs: Array<{ _id: string; _type: string }> =
                    await client.fetch(
                        `*[references($id) && !(_id in path("drafts.**"))]{_id, _type}`,
                        { id },
                    )

                // 2. Find all draft documents that reference this doc
                const referencingDrafts: Array<{ _id: string; _type: string }> =
                    await client.fetch(
                        `*[references($id) && _id in path("drafts.**")]{_id, _type}`,
                        { id },
                    )

                const allRefs = [...referencingDocs, ...referencingDrafts]

                if (allRefs.length > 0) {
                    // 3. For each referencing document, unset every field that points to this id.
                    //    We do a deep-patch using the Sanity mutations API with `unset` on matching refs.
                    const transaction = client.transaction()

                    for (const ref of allRefs) {
                        // Fetch the full document to find which fields contain the reference
                        const doc = await client.getDocument(ref._id)
                        if (!doc) continue

                        const unsetPaths = collectReferencePaths(doc, id)
                        if (unsetPaths.length > 0) {
                            transaction.patch(ref._id, (p) => p.unset(unsetPaths))
                        }
                    }

                    await transaction.commit()
                }

                // 4. Delete draft if it exists
                const draftId = `drafts.${id}`
                const draft = await client.getDocument(draftId)
                if (draft) {
                    await client.delete(draftId)
                }

                // 5. Delete the published document
                await client.delete(id)

                onComplete()
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err)
                setError(msg)
                setIsDeleting(false)
            }
        }, [client, deleteOp, id, onComplete])

        return {
            label: 'Delete',
            icon: TrashIcon,
            tone: 'critical',
            shortcut: null,
            onHandle: () => setShowDialog(true),
            dialog: showDialog
                ? {
                    type: 'custom' as const,
                    onClose: () => {
                        setShowDialog(false)
                        setError(null)
                    },
                    component: () => (
                        <Box padding={4}>
                            <Stack space={4}>
                                <Flex align="center" gap={3}>
                                    <Text size={3}>
                                        <WarningOutlineIcon />
                                    </Text>
                                    <Text size={2} weight="semibold">
                                        Delete document?
                                    </Text>
                                </Flex>

                                <Text size={1} muted>
                                    This will remove all incoming references to this document from
                                    other documents, then permanently delete it. This cannot be
                                    undone.
                                </Text>

                                {error && (
                                    <Card tone="critical" padding={3} radius={2}>
                                        <Text size={1}>{error}</Text>
                                    </Card>
                                )}

                                <Flex gap={3} justify="flex-end">
                                    <Button
                                        mode="ghost"
                                        text="Cancel"
                                        onClick={() => {
                                            setShowDialog(false)
                                            setError(null)
                                        }}
                                        disabled={isDeleting}
                                    />
                                    <Button
                                        tone="critical"
                                        text={isDeleting ? 'Deleting…' : 'Yes, delete'}
                                        icon={isDeleting ? Spinner : TrashIcon}
                                        onClick={handleDelete}
                                        disabled={isDeleting}
                                    />
                                </Flex>
                            </Stack>
                        </Box>
                    ),
                }
                : undefined,
        }
    }

    ForceDeleteAction.action = 'delete'
    return ForceDeleteAction as DocumentActionComponent
}

/**
 * Recursively walk a Sanity document and collect all JSON paths
 * whose value is a reference object pointing to `targetId`.
 */
function collectReferencePaths(
    obj: Record<string, unknown>,
    targetId: string,
    prefix = '',
): string[] {
    const paths: string[] = []

    for (const [key, value] of Object.entries(obj)) {
        if (key.startsWith('_')) continue // skip meta fields at top level

        const path = prefix ? `${prefix}.${key}` : key

        if (isRef(value, targetId)) {
            paths.push(path)
        } else if (Array.isArray(value)) {
            value.forEach((item, i) => {
                if (isRef(item, targetId)) {
                    paths.push(`${path}[${i}]`)
                } else if (item && typeof item === 'object') {
                    paths.push(
                        ...collectReferencePaths(
                            item as Record<string, unknown>,
                            targetId,
                            `${path}[${i}]`,
                        ),
                    )
                }
            })
        } else if (value && typeof value === 'object') {
            paths.push(
                ...collectReferencePaths(
                    value as Record<string, unknown>,
                    targetId,
                    path,
                ),
            )
        }
    }

    return paths
}

function isRef(value: unknown, targetId: string): boolean {
    return (
        typeof value === 'object' &&
        value !== null &&
        '_type' in value &&
        (value as Record<string, unknown>)['_type'] === 'reference' &&
        '_ref' in value &&
        (value as Record<string, unknown>)['_ref'] === targetId
    )
}
