'use client'

/**
 * Sanity Studio config — DesignWear content & commerce hub.
 * Mounted at /designwear-studio
 */

import { visionTool } from '@sanity/vision'
import { defineConfig } from 'sanity'
import { structureTool } from 'sanity/structure'

import { apiVersion, dataset, projectId } from './sanity/env'
import { schema } from './sanity/schemaTypes'
import { structure } from './sanity/structure'
import { PublishAndSync } from './sanity/actions/PublishAndSync'
import { ForceDelete } from './sanity/actions/ForceDelete'
import { StudioLogo } from './sanity/components/StudioLogo'

export default defineConfig({
  basePath: '/designwear-studio',
  projectId,
  dataset,
  title: 'DesignWear Studio',
  icon: StudioLogo,
  schema,
  document: {
    actions: (prev, context) => {
      return prev.map((originalAction) => {
        // Replace the default delete action on every document type
        if (originalAction.action === 'delete') {
          return ForceDelete(originalAction)
        }
        // Replace publish with PublishAndSync only on product documents
        if (context.schemaType === 'product' && originalAction.action === 'publish') {
          return PublishAndSync(originalAction)
        }
        return originalAction
      })
    },
  },
  plugins: [
    structureTool({ structure }),
    visionTool({ defaultApiVersion: apiVersion }),
  ],
})
