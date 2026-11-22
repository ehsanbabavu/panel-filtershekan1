import { createApiHandler } from '../[...path].js';
import { initializeDatabase, pool } from '../../server/database.js';

// Vercel needs an explicit function for this nested route.
export default createApiHandler(pool, initializeDatabase);
