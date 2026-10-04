CREATE TABLE users (
  id text PRIMARY KEY, telegram_user_id text UNIQUE,
  public_id text NOT NULL UNIQUE CHECK (public_id ~ '^[A-Z][A-Z][1-9][0-9]{2}$'),
  canonical_name text NOT NULL CHECK (length(btrim(canonical_name)) > 0),
  role text NOT NULL CHECK (role IN ('OWNER', 'MEMBER')),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'FROZEN', 'SUSPENDED')),
  bot_started smallint NOT NULL DEFAULT 0 CHECK (bot_started IN (0, 1)),
  created_at bigint NOT NULL, updated_at bigint NOT NULL,
  CHECK (bot_started = 0 OR telegram_user_id IS NOT NULL)
);
CREATE UNIQUE INDEX one_owner ON users(role) WHERE role = 'OWNER';
CREATE FUNCTION reject_public_id_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF NEW.public_id <> OLD.public_id THEN RAISE EXCEPTION 'immutable_public_id'; END IF; RETURN NEW; END $$;
CREATE TRIGGER immutable_public_id BEFORE UPDATE OF public_id ON users FOR EACH ROW EXECUTE FUNCTION reject_public_id_change();

CREATE TABLE access_grants (
  id text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id), token_hash text NOT NULL UNIQUE,
  expires_at bigint NOT NULL, used_at bigint, created_by text NOT NULL REFERENCES users(id), created_at bigint NOT NULL,
  revoked_at bigint, CHECK (expires_at > created_at)
);
CREATE INDEX grants_by_user ON access_grants(user_id);
CREATE TABLE audit_events (
  id text PRIMARY KEY, event text NOT NULL, actor_user_id text NOT NULL REFERENCES users(id),
  target_user_id text NOT NULL REFERENCES users(id), trace_id text NOT NULL, metadata_json text NOT NULL,
  created_at bigint NOT NULL, CHECK (metadata_json::jsonb IS NOT NULL)
);
CREATE INDEX audit_by_target ON audit_events(target_user_id, created_at);
CREATE INDEX audit_by_trace ON audit_events(trace_id);
CREATE FUNCTION reject_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit_append_only'; END $$;
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();

CREATE TABLE processed_updates (
  update_id bigint PRIMARY KEY, chat_id text NOT NULL, message_id bigint NOT NULL, trace_id text NOT NULL,
  event text NOT NULL, created_at bigint NOT NULL, UNIQUE(chat_id, message_id)
);
CREATE TABLE runtime_state (key text PRIMARY KEY, value text NOT NULL);
CREATE TABLE response_pool (
  id bigserial PRIMARY KEY, event_key text NOT NULL, actor_role text NOT NULL DEFAULT 'GENERAL', template text NOT NULL,
  source text NOT NULL DEFAULT 'SEED', enabled smallint NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  weight integer NOT NULL DEFAULT 1 CHECK(weight > 0), usage_count integer NOT NULL DEFAULT 0,
  created_at bigint NOT NULL, UNIQUE(event_key, actor_role, template)
);
CREATE TABLE group_membership_cache (
  telegram_chat_id text NOT NULL, telegram_user_id text NOT NULL, telegram_status text NOT NULL,
  is_member smallint NOT NULL CHECK(is_member IN (0,1)), event_date bigint NOT NULL, update_id bigint NOT NULL,
  last_verified_at bigint NOT NULL, source text NOT NULL, PRIMARY KEY(telegram_chat_id, telegram_user_id)
);
CREATE TABLE user_aliases (
  id text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id), alias text NOT NULL, normalized_alias text NOT NULL UNIQUE,
  created_by_user_id text NOT NULL REFERENCES users(id), created_at bigint NOT NULL
);
CREATE TABLE group_roles (telegram_chat_id text NOT NULL, user_id text NOT NULL REFERENCES users(id), role text NOT NULL CHECK(role='ADMIN'), PRIMARY KEY(telegram_chat_id,user_id));
CREATE TABLE group_restrictions (telegram_chat_id text NOT NULL, user_id text NOT NULL REFERENCES users(id), frozen smallint NOT NULL CHECK(frozen IN (0,1)), PRIMARY KEY(telegram_chat_id,user_id));

CREATE TABLE invoices (
  public_ref bigserial PRIMARY KEY, id text NOT NULL UNIQUE, type text NOT NULL CHECK(type IN ('EXPENSE','SETTLEMENT')),
  lifecycle_status text NOT NULL CHECK(lifecycle_status IN ('ACTIVE','VOID')), title text NOT NULL, note text,
  created_at bigint NOT NULL, created_by_user_id text NOT NULL REFERENCES users(id), source_chat_id text NOT NULL,
  source_message_id bigint NOT NULL, input_mode text NOT NULL CHECK(input_mode IN ('DETERMINISTIC','AI_CONFIRMED')),
  currency text NOT NULL CHECK(currency='TOMAN'), gross_amount bigint NOT NULL CHECK(gross_amount >= 0), revision integer NOT NULL DEFAULT 1,
  UNIQUE(source_chat_id, source_message_id)
);
CREATE TABLE response_outbox (
  id bigserial PRIMARY KEY, update_id bigint NOT NULL REFERENCES processed_updates(update_id), encrypted_payload text NOT NULL,
  sent_at bigint, attempts integer NOT NULL DEFAULT 0, next_attempt_at bigint NOT NULL DEFAULT 0,
  invoice_id text REFERENCES invoices(id),
  delivery_status text NOT NULL DEFAULT 'PENDING' CHECK (delivery_status IN ('PENDING','SENDING','SENT','AMBIGUOUS','DISCARDED')),
  last_error_type text
);
CREATE INDEX response_outbox_pending ON response_outbox(next_attempt_at,id) WHERE delivery_status='PENDING';
CREATE TABLE invoice_entries (
  id text PRIMARY KEY, invoice_id text NOT NULL REFERENCES invoices(id), user_id text NOT NULL REFERENCES users(id),
  addressed_as text NOT NULL, input_names_json text NOT NULL, amount bigint NOT NULL, open_amount bigint NOT NULL, position integer NOT NULL,
  UNIQUE(invoice_id,user_id), UNIQUE(invoice_id,position), CHECK(input_names_json::jsonb IS NOT NULL),
  CHECK((amount >= 0 AND open_amount BETWEEN 0 AND amount) OR (amount < 0 AND open_amount BETWEEN amount AND 0))
);
CREATE INDEX entries_by_user ON invoice_entries(user_id);
CREATE TABLE settlement_allocations (
  id text PRIMARY KEY, settlement_invoice_id text NOT NULL REFERENCES invoices(id), settlement_entry_id text NOT NULL REFERENCES invoice_entries(id),
  target_invoice_entry_id text NOT NULL REFERENCES invoice_entries(id), amount bigint NOT NULL CHECK(amount>0),
  side text NOT NULL CHECK(side IN ('PAYER','RECEIVER')), created_at bigint NOT NULL, UNIQUE(settlement_invoice_id,target_invoice_entry_id,side)
);
CREATE INDEX allocations_by_target ON settlement_allocations(target_invoice_entry_id);
CREATE TABLE receipt_messages (chat_id text NOT NULL, message_id bigint NOT NULL, invoice_id text NOT NULL REFERENCES invoices(id), PRIMARY KEY(chat_id,message_id));
CREATE TABLE netting_allocations (
  id text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id), positive_entry_id text NOT NULL REFERENCES invoice_entries(id),
  negative_entry_id text NOT NULL REFERENCES invoice_entries(id), amount bigint NOT NULL CHECK(amount>0), created_at bigint NOT NULL,
  trigger_invoice_id text NOT NULL REFERENCES invoices(id), reason text NOT NULL CHECK(reason='AUTO_AFTER_FINANCIAL_WRITE'),
  CHECK(positive_entry_id <> negative_entry_id)
);
CREATE INDEX netting_positive ON netting_allocations(positive_entry_id);
CREATE INDEX netting_negative ON netting_allocations(negative_entry_id);
CREATE TABLE ai_pending (
  token text PRIMARY KEY, actor_id text NOT NULL REFERENCES users(id), chat_id text NOT NULL, source_message_id bigint NOT NULL,
  intent_json text NOT NULL, preview_json text NOT NULL, created_at bigint NOT NULL, expires_at bigint NOT NULL,
  status text NOT NULL CHECK(status IN ('PENDING','CONFIRMED','CANCELLED')), invoice_id text REFERENCES invoices(id),
  UNIQUE(chat_id,source_message_id), CHECK(intent_json::jsonb IS NOT NULL), CHECK(preview_json::jsonb IS NOT NULL)
);
CREATE TABLE temporary_messages (chat_id text NOT NULL, message_id bigint NOT NULL, PRIMARY KEY(chat_id,message_id));

CREATE TABLE banks (
  id bigserial PRIMARY KEY, name text NOT NULL, manager_id text NOT NULL REFERENCES users(id), signature text NOT NULL UNIQUE,
  balance bigint NOT NULL DEFAULT 0 CHECK(balance BETWEEN 0 AND 9007199254740991), created_by text NOT NULL REFERENCES users(id), created_at bigint NOT NULL
);
CREATE TABLE bank_members (bank_id bigint NOT NULL REFERENCES banks(id), user_id text NOT NULL REFERENCES users(id), weight integer NOT NULL CHECK(weight>0), PRIMARY KEY(bank_id,user_id));
CREATE TABLE bank_transactions (
  id bigserial PRIMARY KEY, bank_id bigint NOT NULL REFERENCES banks(id), kind text NOT NULL CHECK(kind IN ('CHARGE','REFUND','SPEND')),
  amount bigint NOT NULL CHECK(amount BETWEEN 1 AND 9007199254740991), reason text NOT NULL, balance_after bigint NOT NULL CHECK(balance_after>=0),
  actor_id text NOT NULL REFERENCES users(id), chat_id text NOT NULL, message_id bigint NOT NULL, created_at bigint NOT NULL, UNIQUE(chat_id,message_id)
);
CREATE TABLE bank_receipts (transaction_id bigint NOT NULL REFERENCES bank_transactions(id), user_id text NOT NULL REFERENCES users(id), amount bigint NOT NULL CHECK(amount>=0), PRIMARY KEY(transaction_id,user_id));
CREATE INDEX bank_transactions_by_bank ON bank_transactions(bank_id,id);
CREATE TABLE user_ai_credentials (
  user_id text NOT NULL REFERENCES users(id), provider text NOT NULL, encrypted_api_key text NOT NULL,
  enabled smallint NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)), created_at bigint NOT NULL, updated_at bigint NOT NULL,
  PRIMARY KEY(user_id,provider)
);

CREATE FUNCTION reject_bank_structure_change() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'bank_structure_fixed'; END $$;
CREATE TRIGGER bank_structure_fixed BEFORE UPDATE OF name,manager_id,signature ON banks FOR EACH ROW EXECUTE FUNCTION reject_bank_structure_change();
CREATE TRIGGER bank_members_fixed_update BEFORE UPDATE ON bank_members FOR EACH ROW EXECUTE FUNCTION reject_bank_structure_change();
CREATE TRIGGER bank_members_fixed_delete BEFORE DELETE ON bank_members FOR EACH ROW EXECUTE FUNCTION reject_bank_structure_change();
CREATE FUNCTION reject_late_bank_member() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF EXISTS(SELECT 1 FROM bank_transactions WHERE bank_id=NEW.bank_id) THEN RAISE EXCEPTION 'bank_structure_fixed'; END IF; RETURN NEW; END $$;
CREATE TRIGGER bank_members_fixed_insert BEFORE INSERT ON bank_members FOR EACH ROW EXECUTE FUNCTION reject_late_bank_member();
CREATE FUNCTION reject_bank_ledger_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'bank_append_only'; END $$;
CREATE TRIGGER bank_transaction_no_update BEFORE UPDATE ON bank_transactions FOR EACH ROW EXECUTE FUNCTION reject_bank_ledger_mutation();
CREATE TRIGGER bank_transaction_no_delete BEFORE DELETE ON bank_transactions FOR EACH ROW EXECUTE FUNCTION reject_bank_ledger_mutation();
CREATE TRIGGER bank_receipt_no_update BEFORE UPDATE ON bank_receipts FOR EACH ROW EXECUTE FUNCTION reject_bank_ledger_mutation();
CREATE TRIGGER bank_receipt_no_delete BEFORE DELETE ON bank_receipts FOR EACH ROW EXECUTE FUNCTION reject_bank_ledger_mutation();
