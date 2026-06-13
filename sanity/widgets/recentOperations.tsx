import { useEffect, useState } from 'react'
import { Box, Card, Text, Badge, Stack } from '@sanity/ui'

interface Operation {
  id: string
  type: string
  document: string
  timestamp: string
  status: 'success' | 'failed'
}

export default function recentOperationsWidget() {
  return {
    name: 'recent-operations',
    component: RecentOperationsComponent,
    layout: { width: 'large', height: 'medium' },
  }
}

const thStyle: React.CSSProperties = { textAlign: 'left', padding: '4px 8px', borderBottom: '1px solid var(--card-border-color)' }
const tdStyle: React.CSSProperties = { padding: '4px 8px', borderBottom: '1px solid var(--card-border-color)' }

function RecentOperationsComponent() {
  const [operations, setOperations] = useState<Operation[]>([])

  useEffect(() => {
    const fetchOperations = async () => {
      try {
        const response = await fetch('/api/operations/recent?limit=10')
        const data = await response.json()
        setOperations(data)
      } catch (error) {
        console.error('Failed to fetch operations:', error)
      }
    }

    fetchOperations()
    const interval = setInterval(fetchOperations, 15000)
    return () => clearInterval(interval)
  }, [])

  return (
    <Card padding={4} height="fill">
      <Stack space={4}>
        <Text size={2} weight="semibold">
          Recent Database Operations
        </Text>

        {operations.length === 0 ? (
          <Text size={1} muted>
            No recent operations
          </Text>
        ) : (
          <Box style={{ maxHeight: '280px', overflowY: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={thStyle}><Text size={1} weight="semibold">Type</Text></th>
                  <th style={thStyle}><Text size={1} weight="semibold">Document</Text></th>
                  <th style={thStyle}><Text size={1} weight="semibold">Time</Text></th>
                  <th style={thStyle}><Text size={1} weight="semibold">Status</Text></th>
                </tr>
              </thead>
              <tbody>
                {operations.map((op) => (
                  <tr key={op.id}>
                    <td style={tdStyle}><Text size={1}>{op.type}</Text></td>
                    <td style={tdStyle}><Text size={1}>{op.document}</Text></td>
                    <td style={tdStyle}>
                      <Text size={1} muted>{new Date(op.timestamp).toLocaleTimeString()}</Text>
                    </td>
                    <td style={tdStyle}>
                      <Badge tone={op.status === 'success' ? 'positive' : 'critical'} padding={2} fontSize={0}>
                        {op.status}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

          </Box>
        )}
      </Stack>
    </Card>
  )
}
