import { initializeDatabase, pool } from '../server/database.js';
import { createTelegramHandler } from '../server/telegram.js';

export default createTelegramHandler(pool, initializeDatabase);
