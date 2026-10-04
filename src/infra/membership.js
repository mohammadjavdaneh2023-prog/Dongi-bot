import { transaction } from './db/database.js';

export function syncMembership(db, update) {
  const member = update.chat_member ?? update.my_chat_member;
  const message = update.message;
  const chat = member?.chat ?? message?.chat;
  if (!['group', 'supergroup'].includes(chat?.type)) return false;
  let changes = [];
  const date = member?.date ?? message?.date;
  if (member) {
    const current = member.new_chat_member;
    if (!current?.user) return false;
    changes = [{ id: current.user.id, status: current.status,
      active: ['creator', 'administrator', 'member'].includes(current.status)
        || (current.status === 'restricted' && current.is_member === true) }];
  } else if (message?.new_chat_members) {
    changes = message.new_chat_members.map(user => ({ id: user.id, status: 'member', active: true }));
  } else if (message?.left_chat_member) {
    changes = [{ id: message.left_chat_member.id, status: 'left', active: false }];
  } else return false;
  if (![chat.id, update.update_id, date, ...changes.map(change => change.id)].every(Number.isSafeInteger)) return false;
  transaction(db, () => {
    const insert = db.prepare(`INSERT INTO group_membership_cache
      (telegram_chat_id, telegram_user_id, telegram_status, is_member, event_date, update_id, last_verified_at, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'SERVICE_UPDATE')
      ON CONFLICT(telegram_chat_id, telegram_user_id) DO UPDATE SET
        telegram_status = excluded.telegram_status, is_member = excluded.is_member,
        event_date = excluded.event_date, update_id = excluded.update_id, last_verified_at = excluded.last_verified_at
      WHERE excluded.event_date > group_membership_cache.event_date
        OR (excluded.event_date = group_membership_cache.event_date
          AND excluded.update_id > group_membership_cache.update_id)`);
    for (const change of changes) insert.run(String(chat.id), String(change.id), change.status, Number(change.active), date, update.update_id, Date.now());
  });
  return true;
}
