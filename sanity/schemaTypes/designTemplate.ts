import { defineField, defineType } from 'sanity'

export default defineType({
  name: 'designTemplate',
  title: 'Design Template',
  type: 'document',
  fields: [
    defineField({
      name: 'templateId', title: 'Template ID', type: 'slug',
      options: { source: 'name' },
      validation: (R) => R.required(),
    }),
    defineField({ name: 'name',        title: 'Template Name', type: 'string', validation: (R) => R.required() }),
    defineField({ name: 'description', title: 'Description',   type: 'string' }),
    defineField({
      name: 'category', title: 'Category', type: 'string',
      options: {
        list: ['vintage', 'minimalist', 'sports', 'urban', 'nature', 'corporate', 'artistic', 'funny'],
      },
      validation: (R) => R.required(),
    }),
    defineField({
      name: 'thumbnail', title: 'Thumbnail Image', type: 'image',
      options: { hotspot: true },
    }),
    defineField({
      name: 'tags', title: 'Tags', type: 'array',
      of: [{ type: 'string' }],
    }),
    defineField({
      name: 'designData', title: 'Design JSON Data', type: 'text',
      description: 'JSON string — CustomDesign: { baseColor: "0xFFFFFFFF", elements: [...] }',
      rows: 8,
    }),
    defineField({ name: 'active', title: 'Active',        type: 'boolean', initialValue: true }),
    defineField({ name: 'order',  title: 'Display Order', type: 'number',  initialValue: 1 }),
  ],
  orderings: [
    { title: 'Display Order', name: 'orderAsc', by: [{ field: 'order', direction: 'asc' }] },
  ],
  preview: {
    select: { title: 'name', subtitle: 'category', media: 'thumbnail' },
  },
})
