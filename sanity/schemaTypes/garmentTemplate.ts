import { defineType, defineField } from 'sanity'

export default defineType({
  name: 'garmentTemplate',
  title: 'Garment Template',
  type: 'document',
  fields: [
    defineField({
      name: 'id',
      title: 'Garment ID',
      type: 'string',
      description: 'Canonical ID used in Flutter (e.g. "tshirt", "hoodie", "cap")',
      validation: (Rule) => Rule.required(),
    }),
    defineField({
      name: 'label',
      title: 'Display Label',
      type: 'string',
      description: 'Human-readable name (e.g. "T-Shirt")',
      validation: (Rule) => Rule.required(),
    }),
    defineField({
      name: 'frontImage',
      title: 'Front Image',
      type: 'image',
      description: 'White-base front garment silhouette (PNG with transparency)',
      options: { hotspot: false },
    }),
    defineField({
      name: 'backImage',
      title: 'Back Image',
      type: 'image',
      description: 'White-base back garment silhouette (PNG with transparency)',
      options: { hotspot: false },
    }),
    defineField({
      name: 'supportsCollarPocket',
      title: 'Supports Collar / Pocket Overlay',
      type: 'boolean',
      description: 'Enable the collar + pocket customisation overlay (T-Shirt only)',
      initialValue: false,
    }),
    defineField({
      name: 'sortOrder',
      title: 'Sort Order',
      type: 'number',
      description: 'Lower numbers appear first in the garment type picker',
      initialValue: 99,
    }),
  ],
  preview: {
    select: { title: 'label', subtitle: 'id', media: 'frontImage' },
  },
})
