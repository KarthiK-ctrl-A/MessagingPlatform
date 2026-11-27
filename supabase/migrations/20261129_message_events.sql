-- Apply after 20261128_error_codes.sql in the existing clinical database.
-- Live delivery, part 1 (transactional outbox):
--   * Every committed row in public.messages, whether written by Server B or by
--     the clinical app's own Data API path, gets one outbox row in the SAME
--     transaction, so an event can never be lost or announce an uncommitted message.
--   * pg_notify wakes Server B's relay on commit; the relay publishes a signed
--     event on NATS and marks the row published.
--   * Events carry identifiers and the two participant IDs only, never content.
--     A message can be inserted only while its patient/doctor pair is the current
--     assignment (enforced by prepare_clinical_message), so both participants are
--     authorised for that conversation at the moment the event is created.
-- Also adds a single-statement "newer than cursor" history read for gap filling.
BEGIN;

CREATE TABLE internal.message_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  user_low uuid NOT NULL,
  user_high uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  published_at timestamptz
);
CREATE INDEX message_outbox_pending
  ON internal.message_outbox (created_at, id) WHERE published_at IS NULL;
CREATE INDEX message_outbox_published
  ON internal.message_outbox (published_at) WHERE published_at IS NOT NULL;

REVOKE ALL ON internal.message_outbox FROM PUBLIC, anon, authenticated;
GRANT SELECT ON internal.message_outbox TO messaging_b_runtime;
GRANT UPDATE (published_at) ON internal.message_outbox TO messaging_b_runtime;
GRANT DELETE ON internal.message_outbox TO messaging_b_runtime;
ALTER TABLE internal.message_outbox ENABLE ROW LEVEL SECURITY;
CREATE POLICY messaging_b_outbox_read ON internal.message_outbox
  FOR SELECT TO messaging_b_runtime USING (true);
CREATE POLICY messaging_b_outbox_publish ON internal.message_outbox
  FOR UPDATE TO messaging_b_runtime USING (true) WITH CHECK (published_at IS NOT NULL);
CREATE POLICY messaging_b_outbox_cleanup ON internal.message_outbox
  FOR DELETE TO messaging_b_runtime
  USING (published_at IS NOT NULL AND published_at < now() - interval '1 day');

CREATE OR REPLACE FUNCTION internal.enqueue_message_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_user_low uuid;
  v_user_high uuid;
BEGIN
  SELECT c.user_low, c.user_high INTO v_user_low, v_user_high
  FROM public.conversations c
  WHERE c.id = NEW.conversation_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Conversation unavailable' USING ERRCODE = 'MP404';
  END IF;
  INSERT INTO internal.message_outbox (message_id, conversation_id, user_low, user_high)
  VALUES (NEW.id, NEW.conversation_id, v_user_low, v_user_high);
  -- Delivered only on commit; identical notifications in one transaction collapse.
  PERFORM pg_notify('messaging_outbox', '');
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION internal.enqueue_message_event() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER enqueue_message_event_after_insert
  AFTER INSERT ON public.messages
  FOR EACH ROW EXECUTE FUNCTION internal.enqueue_message_event();

-- Messages newer than a (created_at, id) cursor, oldest first. Same security
-- model as internal.read_message_page: runs as the caller under RLS.
CREATE OR REPLACE FUNCTION internal.read_messages_after(
  p_actor_id uuid,
  p_conversation_id uuid,
  p_page_size integer,
  p_after_created_at timestamptz,
  p_after_id uuid
)
RETURNS TABLE (
  id uuid,
  conversation_id uuid,
  sender_id uuid,
  client_message_id uuid,
  content text,
  created_at timestamptz
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF p_actor_id IS NULL OR p_conversation_id IS NULL OR p_after_created_at IS NULL OR p_after_id IS NULL
     OR p_page_size IS NULL OR p_page_size < 1 OR p_page_size > 50 THEN
    RAISE EXCEPTION 'Invalid history arguments' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.set_config('app.user_id', p_actor_id::text, true);
  IF NOT EXISTS (
    SELECT 1 FROM public.conversations AS c WHERE c.id = p_conversation_id
  ) THEN
    RAISE EXCEPTION 'Conversation not found' USING ERRCODE = 'P0002';
  END IF;
  RETURN QUERY
    SELECT m.id, m.conversation_id, m.sender_id, m.client_message_id, m.content, m.created_at
    FROM public.messages AS m
    WHERE m.conversation_id = p_conversation_id
      AND (m.created_at, m.id) > (p_after_created_at, p_after_id)
    ORDER BY m.created_at ASC, m.id ASC
    LIMIT p_page_size;
END;
$$;
REVOKE ALL ON FUNCTION internal.read_messages_after(uuid,uuid,integer,timestamptz,uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION internal.read_messages_after(uuid,uuid,integer,timestamptz,uuid)
  TO messaging_b_runtime;

COMMIT;
