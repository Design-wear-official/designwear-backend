import { defineField, defineType } from 'sanity'

export default defineType({
  name: 'homeBanner',
  title: 'Home Banner',
  type: 'document',
  fields: [
    defineField({ name: 'badge',    title: 'Badge Text',       type: 'string', validation: (R) => R.required() }),
    defineField({ name: 'title',    title: 'Title',            type: 'string', validation: (R) => R.required() }),
    defineField({ name: 'subtitle', title: 'Subtitle',         type: 'string' }),
    defineField({ name: 'ctaLabel', title: 'CTA Button Label', type: 'string', initialValue: 'SHOP NOW' }),
    defineField({
      name: 'ctaAction', title: 'CTA Action', type: 'string',
      options: { list: [
        { title: 'Shop (scroll to products)', value: 'shop' },
        { title: 'Design Studio',             value: 'design' },
        { title: 'Deals (scroll to deals)',   value: 'deal' },
      ]},
      initialValue: 'shop',
    }),
    defineField({
      name: 'ctaColor', title: 'Accent Color', type: 'string',
      options: { list: ['purple', 'blue', 'orange'] },
      initialValue: 'purple',
    }),
    defineField({
      name: 'image', title: 'Banner Image', type: 'image',
      options: { hotspot: true },
      validation: (R) => R.required(),
    }),
    defineField({ name: 'order',  title: 'Display Order', type: 'number',  initialValue: 1 }),
    defineField({ name: 'active', title: 'Active',        type: 'boolean', initialValue: true }),
  ],
  orderings: [
    { title: 'Display Order', name: 'orderAsc', by: [{ field: 'order', direction: 'asc' }] },
  ],
  preview: {
    select: { title: 'title', subtitle: 'badge', media: 'image' },
  },
})
