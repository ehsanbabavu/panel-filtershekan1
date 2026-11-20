import { initializeDatabase, pool } from '../server/database.js';
import { createMobileHandler } from '../server/mobile.js';

export default createMobileHandler(pool, initializeDatabase);
