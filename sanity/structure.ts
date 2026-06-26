import { StructureBuilder } from 'sanity/structure'
import {
  PackageIcon,
  TagIcon,
  BasketIcon,
  UserIcon,
  ArchiveIcon,
  ActivityIcon,
  BellIcon,
  TrolleyIcon,
  SparklesIcon,
  StarIcon,
} from '@sanity/icons'

export const structure = (S: StructureBuilder) =>
  S.list()
    .title('DesignWear')
    .items([
      S.listItem()
        .title('Products')
        .icon(PackageIcon)
        .child(
          S.list()
            .title('Product Management')
            .items([
              S.listItem()
                .title('All Products')
                .icon(PackageIcon)
                .child(S.documentTypeList('product').title('All Products')),
              S.listItem()
                .title('Active Products')
                .icon(SparklesIcon)
                .child(
                  S.documentTypeList('product')
                    .title('Active Products')
                    .filter('_type == "product" && status == "active"')
                ),
              S.listItem()
                .title('Out of Stock')
                .icon(ArchiveIcon)
                .child(
                  S.documentTypeList('product')
                    .title('Out of Stock')
                    .filter('_type == "product" && stock <= 0')
                ),
              S.listItem()
                .title('Customizable (Design Studio)')
                .icon(SparklesIcon)
                .child(
                  S.documentTypeList('product')
                    .title('Customizable Products')
                    .filter('_type == "product" && customizable == true')
                ),
              S.listItem()
                .title('Featured')
                .icon(StarIcon)
                .child(
                  S.documentTypeList('product')
                    .title('Featured Products')
                    .filter('_type == "product" && featured == true')
                ),
            ])
        ),
      S.divider(),
      S.documentTypeListItem('category').title('Categories').icon(TagIcon),
      S.documentTypeListItem('order').title('Orders').icon(BasketIcon),
      S.documentTypeListItem('customer').title('Customers').icon(UserIcon),
      S.divider(),
      S.listItem()
        .title('Inventory')
        .icon(ArchiveIcon)
        .child(
          S.list()
            .title('Inventory Management')
            .items([
              S.documentTypeListItem('inventoryMovement')
                .title('Stock Movements')
                .icon(ActivityIcon),
              S.documentTypeListItem('supplier')
                .title('Suppliers')
                .icon(TrolleyIcon),
            ])
        ),
      S.divider(),
      S.documentTypeListItem('garmentTemplate')
        .title('Garment Templates')
        .icon(SparklesIcon),
      S.divider(),
      S.documentTypeListItem('notificationTemplate')
        .title('Notification Templates')
        .icon(BellIcon),
      S.documentTypeListItem('systemLog').title('System Logs').icon(ActivityIcon),
    ])
