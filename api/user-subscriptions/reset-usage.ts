import { createApiHandler } from '../[...path].js';
import { initializeDatabase, pool } from '../../server/database.js';

export default createApiHandler(pool, initializeDatabase);
