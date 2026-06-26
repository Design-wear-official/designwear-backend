import product from './product'
import category from './category'
import order from './order'
import customer from './customer'
import inventoryMovement from './inventoryMovement'
import supplier from './supplier'
import systemLog from './systemLog'
import notificationTemplate from './notificationTemplate'
import homeBanner from './homeBanner'
import deal from './deal'
import designTemplate from './designTemplate'
import categoryQuickLink from './categoryQuickLink'
import garmentTemplate from './garmentTemplate'

export const schema = {
    types: [
        // Catalog
        product,
        category,
        // Transactions
        order,
        customer,
        inventoryMovement,
        // Operations
        supplier,
        systemLog,
        notificationTemplate,
        // Content (Flutter home screen)
        homeBanner,
        deal,
        designTemplate,
        categoryQuickLink,
        // Design Studio
        garmentTemplate,
    ]
}
