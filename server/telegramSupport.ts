import { telegramHomeCommand, telegramMenuLabels } from './telegramMenu.js';

const sqlLiteral = (value: string) => "'" + value.replaceAll("'", "''") + "'";
const menuLabels = Object.values(telegramMenuLabels).map(sqlLiteral).join(',');

export const telegramSupportSchema = `
  CREATE TABLE IF NOT EXISTS telegram_webhook_updates (
    bot_id BIGINT NOT NULL, update_id BIGINT NOT NULL,
    chat_id TEXT, menu_message_id BIGINT, opens_support BOOLEAN,
    PRIMARY KEY(bot_id,update_id)
  );
  CREATE INDEX IF NOT EXISTS telegram_webhook_updates_menu_idx
    ON telegram_webhook_updates(bot_id,chat_id,menu_message_id DESC) WHERE menu_message_id IS NOT NULL;
  DO $telegram_support$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_attribute
      WHERE attrelid='telegram_chat_messages'::regclass AND attname='is_support' AND NOT attisdropped)
    THEN
      ALTER TABLE telegram_chat_messages ADD COLUMN is_support BOOLEAN NOT NULL DEFAULT FALSE;

      WITH legacy_menu AS (
        SELECT bot_id,update_id,chat_id,message_id,
          btrim(regexp_replace(replace(text,chr(8204),' '),'[[:space:]]+',' ','g')) AS label
        FROM telegram_messages
        WHERE NOT edited AND content_type='text' AND chat_id ~ '^[1-9][0-9]*$'
      )
      INSERT INTO telegram_webhook_updates(bot_id,update_id,chat_id,menu_message_id,opens_support)
        SELECT bot_id,update_id,chat_id,message_id,label=${sqlLiteral(telegramMenuLabels.support)}
        FROM legacy_menu WHERE label IN (${menuLabels}) OR label ~* ${sqlLiteral(telegramHomeCommand)}
        ON CONFLICT(bot_id,update_id) DO NOTHING;

      UPDATE telegram_chat_messages SET is_support=TRUE WHERE direction='outgoing';

      INSERT INTO telegram_chat_messages(bot_id,chat_id,message_id,chat_title,sender_name,sender_username,text,
        direction,sent_at,content_type,edited,update_id,is_support)
        SELECT DISTINCT ON(m.bot_id,m.chat_id,m.message_id)
          m.bot_id,m.chat_id,m.message_id,m.chat_title,m.sender_name,m.sender_username,m.text,
          'incoming',m.sent_at,m.content_type,m.edited,m.update_id,TRUE
        FROM telegram_messages m
        JOIN LATERAL (
          SELECT menu_message_id,opens_support FROM telegram_webhook_updates
          WHERE bot_id=m.bot_id AND chat_id=m.chat_id AND menu_message_id<=m.message_id
          ORDER BY menu_message_id DESC LIMIT 1
        ) menu ON menu.opens_support AND menu.menu_message_id<m.message_id
        ORDER BY m.bot_id,m.chat_id,m.message_id,m.edited DESC,m.id DESC
        ON CONFLICT(bot_id,chat_id,message_id) DO UPDATE SET is_support=TRUE;
    END IF;
  END
  $telegram_support$;
`;
