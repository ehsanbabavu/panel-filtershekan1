import type { MobileDatabase } from './presence.js';

export function createSubscriptionUsageResetHandler(database: MobileDatabase) {
  return async function resetUsage(req: any, res: any) {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).json({ message: 'روش درخواست پشتیبانی نمی‌شود.' });
    }
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const userId = Number(body.userId);
    if (!['string', 'number'].includes(typeof body.userId) || !Number.isSafeInteger(userId) || userId < 1) {
      return res.status(400).json({ message: 'شناسه کاربر معتبر نیست.' });
    }
    const client = await database.connect();
    try {
      await client.query('BEGIN');
      // Serialize with mobile usage reports and subscription changes for this account.
      const user = (await client.query<any>(`SELECT id,subscription_started_at,subscription_expires_at,
        subscription_quota_bytes,blocked,(subscription_expires_at>NOW()) AS time_active
        FROM users WHERE id=$1 FOR UPDATE`, [userId])).rows[0];
      if (!user || !user.subscription_started_at || !user.subscription_expires_at || !user.subscription_quota_bytes) {
        await client.query('ROLLBACK');
        return res.status(404).json({ message: 'اشتراک کاربر پیدا نشد.' });
      }
      await client.query('UPDATE users SET subscription_used_bytes=0 WHERE id=$1', [userId]);
      await client.query(`UPDATE user_subscriptions SET used_bytes=0,
        status=CASE WHEN expires_at>NOW() THEN 'active' ELSE 'expired' END
        WHERE id=(SELECT s.id FROM user_subscriptions s JOIN users u ON u.id=s.user_id
          WHERE s.user_id=$1 AND s.status<>'cancelled' AND s.started_at=u.subscription_started_at
            AND s.expires_at=u.subscription_expires_at ORDER BY s.id DESC LIMIT 1)`, [userId]);
      // Keep cumulative mobile counters as baselines: the next heartbeat adds only new bytes.
      await client.query('COMMIT');
      return res.status(200).json({ userId: String(user.id), usedBytes: '0',
        startedAt: user.subscription_started_at, expiresAt: user.subscription_expires_at,
        quotaBytes: String(user.subscription_quota_bytes), blocked: Boolean(user.blocked), active: Boolean(user.time_active) });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { client.release(); }
  };
}
