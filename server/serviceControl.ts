import type { Pool } from 'pg';

type ServiceDatabase = Pick<Pool, 'query' | 'connect'>;

export async function getMaintenanceMode(database: Pick<Pool, 'query'>) {
  const result = await database.query<any>('SELECT maintenance_mode AS "maintenanceMode" FROM service_settings WHERE id=1');
  return Boolean(result.rows[0]?.maintenanceMode);
}

export async function setMaintenanceMode(database: ServiceDatabase, enabled: boolean) {
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query<any>('SELECT maintenance_mode FROM service_settings WHERE id=1 FOR UPDATE');
    const previous = Boolean(current.rows[0]?.maintenance_mode);
    if (previous === enabled) {
      await client.query('COMMIT');
      return { maintenanceMode: enabled, changed: false, notifiedUsers: 0 };
    }

    await client.query('UPDATE service_settings SET maintenance_mode=$1,updated_at=NOW() WHERE id=1', [enabled]);
    if (enabled) {
      await client.query('UPDATE app_user_sessions SET vpn_connected=FALSE,vpn_heartbeat_at=NULL WHERE vpn_connected=TRUE');
    }
    const message = enabled
      ? '🛠️ سرویس فیلترشکن برای به‌روزرسانی موقتاً متوقف شده است. بابت اختلال و زحمتی که ایجاد شده صمیمانه عذرخواهی می‌کنیم. پس از پایان به‌روزرسانی، از همین‌جا اطلاع‌رسانی می‌کنیم.'
      : '✅ به‌روزرسانی انجام شد و سرویس فیلترشکن دوباره فعال است. اکنون می‌توانید مجدداً به سرویس متصل شوید. از صبر و همراهی شما سپاسگزاریم.';
    const notified = await client.query<any>(`INSERT INTO chat_messages(user_id,sender_role,author,message,read_by_admin)
      SELECT id,'admin','پشتیبانی',$1,TRUE FROM users RETURNING user_id`, [message]);
    await client.query('COMMIT');
    return { maintenanceMode: enabled, changed: true, notifiedUsers: notified.rowCount || 0 };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}
