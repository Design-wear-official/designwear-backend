import { defineField, defineType } from 'sanity'

export default defineType({
  name: 'categoryQuickLink',
  title: 'Category Quick Link',
  type: 'document',
  fields: [
    defineField({
      name: 'label',
      title: 'Label',
      type: 'string',
      description: 'Short label shown below the icon (e.g. "Trending", "New In")',
      validation: (R) => R.required(),
    }),
    defineField({
      name: 'iconName',
      title: 'Icon',
      type: 'string',
      description: 'Material icon name used in the Flutter app',
      options: {
        list: [
          { title: 'Style / Design', value: 'style' },
          { title: 'Fire / Trending', value: 'local_fire_department' },
          { title: 'New Releases / New In', value: 'new_releases' },
          { title: 'Tag / Sale', value: 'sell' },
          { title: 'Checkroom / T-Shirts', value: 'checkroom' },
          { title: 'Snowflake / Hoodies', value: 'ac_unit' },
          { title: 'Sports / Polo', value: 'sports_soccer' },
          { title: 'Diamond / Premium', value: 'diamond' },
          { title: 'Dry Cleaning / Garment', value: 'dry_cleaning' },
          { title: 'Star / Top Picks', value: 'star' },
          { title: 'Flash / Flash Sale', value: 'flash_on' },
          { title: 'Collections', value: 'collections' },
        ],
      },
      validation: (R) => R.required(),
    }),
    defineField({
      name: 'colorHex',
      title: 'Icon Color',
      type: 'string',
      description: 'Hex color code e.g. #3B82F6',
      validation: (R) => R.required(),
    }),
    defineField({
      name: 'action',
      title: 'On-tap Action',
      type: 'string',
      options: {
        list: [
          { title: 'Open Design Studio', value: 'design-studio' },
          { title: 'Jump to filter tab', value: 'tab' },
        ],
      },
      validation: (R) => R.required(),
    }),
    defineField({
      name: 'tabIndex',
      title: 'Filter Tab Index',
      type: 'number',
      description:
        'Only used when action is "tab". 0=All, 2=T-Shirts, 3=Hoodies, 4=Polo, 6=Trending, 7=New Arrivals, 8=Sale',
    }),
    defineField({
      name: 'order',
      title: 'Display Order',
      type: 'number',
      initialValue: 0,
      description: 'Lower numbers appear first',
    }),
    defineField({
      name: 'active',
      title: 'Active',
      type: 'boolean',
      initialValue: true,
    }),
  ],
  orderings: [
    {
      title: 'Display Order',
      name: 'orderAsc',
      by: [{ field: 'order', direction: 'asc' }],
    },
  ],
  preview: {
    select: { title: 'label', subtitle: 'action', color: 'colorHex' },
    prepare: ({
      title,
      subtitle,
    }: {
      title: string
      subtitle: string
      color: string
    }) => ({
      title,
      subtitle: subtitle === 'design-studio' ? 'Opens Design Studio' : `Tab action`,
    }),
  },
})
