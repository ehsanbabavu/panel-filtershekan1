import { createApiHandler } from '../../[...path].js';
import { initializeDatabase, pool } from '../../../server/database.js';

// Pin the invoice test endpoint to an explicit Vercel function route.
export default createApiHandler(pool, initializeDatabase);
