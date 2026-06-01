// Barrel file — import from '@/lib' instead of individual paths
export { db, connectDatabase, closeDatabaseConnection } from './config/database'
export { logger }                                         from './utils/logger'
export {
  syncProductToDatabase,
  syncCustomerToSanity,
  checkDocumentExists,
}                                                         from './services/syncService'
