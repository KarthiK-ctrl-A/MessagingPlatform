-- Apply in the existing Supabase project's SQL Editor as the migration owner.
-- This function runs with messaging_b_runtime's privileges and existing RLS.
-- It replaces four sequential history transaction statements with one call.
BEGIN;

CREATE OR REPLACE FUNCTION internal.read_message_page(
  p_actor_id uuid,
  p_conversation_id uuid,
  p_page_size integer,
  p_before_created_at timestamptz,
  p_before_id uuid
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
  IF p_actor_id IS NULL OR p_conversation_id IS NULL
     OR p_page_size IS NULL OR p_page_size < 2 OR p_page_size > 51
     OR (p_before_created_at IS NULL) <> (p_before_id IS NULL) THEN
    RAISE EXCEPTION 'Invalid history arguments' USING ERRCODE = '22023';
  END IF;

  -- true makes the identity local to this one statement's transaction.
  PERFORM pg_catalog.set_config('app.user_id', p_actor_id::text, true);

  -- The conversation and message SELECTs both run as messaging_b_runtime.
  -- Their RLS policies enforce the current patient/doctor assignment.
  IF NOT EXISTS (
    SELECT 1 FROM public.conversations AS c WHERE c.id = p_conversation_id
  ) THEN
    RAISE EXCEPTION 'Conversation not found' USING ERRCODE = 'P0002';
  END IF;

  IF p_before_created_at IS NULL THEN
    RETURN QUERY
      SELECT m.id, m.conversation_id, m.sender_id, m.client_message_id,
             m.content, m.created_at
      FROM public.messages AS m
      WHERE m.conversation_id = p_conversation_id
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT p_page_size;
  ELSE
    RETURN QUERY
      SELECT m.id, m.conversation_id, m.sender_id, m.client_message_id,
             m.content, m.created_at
      FROM public.messages AS m
      WHERE m.conversation_id = p_conversation_id
        AND (m.created_at, m.id) < (p_before_created_at, p_before_id)
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT p_page_size;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION internal.read_message_page(uuid,uuid,integer,timestamptz,uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION internal.read_message_page(uuid,uuid,integer,timestamptz,uuid)
  TO messaging_b_runtime;

COMMIT;
