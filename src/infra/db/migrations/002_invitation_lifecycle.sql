ALTER TABLE users ADD COLUMN retired_at bigint;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_public_id_key;
CREATE UNIQUE INDEX users_public_id_active ON users(public_id) WHERE retired_at IS NULL;

ALTER TABLE access_grants ADD COLUMN status text NOT NULL DEFAULT 'PENDING'
  CHECK (status IN ('PENDING', 'ACCEPTED', 'EXPIRED'));
ALTER TABLE access_grants ADD COLUMN reserved_public_id text;
ALTER TABLE access_grants ADD COLUMN reserved_name text;
ALTER TABLE access_grants ADD COLUMN normalized_name text;
ALTER TABLE access_grants ADD COLUMN reservation_enforced smallint NOT NULL DEFAULT 0 CHECK (reservation_enforced IN (0,1));

UPDATE access_grants AS g
SET reserved_public_id = u.public_id,
    reserved_name = u.canonical_name,
    normalized_name = lower(btrim(u.canonical_name)),
    expires_at = g.created_at + 3600000,
    status = CASE WHEN g.used_at IS NOT NULL THEN 'ACCEPTED'
                  WHEN g.revoked_at IS NOT NULL THEN 'EXPIRED'
                  ELSE 'PENDING' END
FROM users AS u
WHERE u.id = g.user_id;

ALTER TABLE access_grants ALTER COLUMN reserved_public_id SET NOT NULL;
ALTER TABLE access_grants ALTER COLUMN reserved_name SET NOT NULL;
ALTER TABLE access_grants ALTER COLUMN normalized_name SET NOT NULL;
CREATE UNIQUE INDEX invitation_reserved_public_id ON access_grants(reserved_public_id)
  WHERE status IN ('PENDING', 'ACCEPTED');
CREATE UNIQUE INDEX invitation_reserved_name_active ON access_grants(normalized_name)
  WHERE reservation_enforced=1 AND status IN ('PENDING', 'ACCEPTED');
CREATE INDEX invitation_expiry_scan ON access_grants(expires_at, id) WHERE status='PENDING';

ALTER TABLE response_outbox ADD COLUMN idempotency_key text UNIQUE;
ALTER TABLE response_outbox ADD COLUMN sending_started_at bigint;
CREATE SEQUENCE internal_outbox_update_id START WITH -1 INCREMENT BY -1 MINVALUE -9223372036854775807;
