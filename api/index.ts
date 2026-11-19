import type { VercelRequest, VercelResponse } from '@vercel/node';
import app, { initializeDatabase } from '../server/index';

let ready: Promise<void> | undefined;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  ready ??= initializeDatabase().catch((error) => {
    ready = undefined;
    throw error;
  });

  try {
    await ready;
    return app(req, res);
  } catch (error) {
    console.error('Could not initialize FilterShekan database:', error);
    return res.status(503).json({ message: 'اتصال پایگاه داده برقرار نشد.' });
  }
}
