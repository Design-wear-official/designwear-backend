import { defineField, defineType } from 'sanity'

export default defineType({
  name: 'deal',
  title: "Today's Deal",
  type: 'document',
  fields: [
    defineField({ name: 'label',           title: 'Product Label',      type: 'string', validation: (R) => R.required() }),
    defineField({ name: 'originalPrice',   title: 'Original Price (₹)', type: 'number', validation: (R) => R.required().min(0) }),
    defineField({ name: 'salePrice',       title: 'Sale Price (₹)',     type: 'number', validation: (R) => R.required().min(0) }),
    defineField({ name: 'discountPercent', title: 'Discount %',         type: 'number', validation: (R) => R.min(0).max(100) }),
    defineField({
      name: 'colorHex', title: 'Card Accent Color', type: 'string',
      description: 'Hex color e.g. #3B82F6',
      initialValue: '#3B82F6',
    }),
    defineField({
      name: 'product', title: 'Linked Product', type: 'reference',
      to: [{ type: 'product' }],
      options: { disableNew: true },
    }),
    defineField({ name: 'active',    title: 'Active',     type: 'boolean',  initialValue: true }),
    defineField({ name: 'expiresAt', title: 'Expires At', type: 'datetime', description: 'Leave empty for no expiry' }),
  ],
  preview: {
    select: { title: 'label', subtitle: 'discountPercent' },
    prepare: ({ title, subtitle }: { title: string; subtitle: number }) => ({
      title,
      subtitle: subtitle ? `${subtitle}% off` : '',
    }),
  },
})
