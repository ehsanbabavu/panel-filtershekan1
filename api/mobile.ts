import { initializeDatabase, pool } from '../server/database';
import { createMobileHandler } from '../server/mobile';

export default createMobileHandler(pool, initializeDatabase);
