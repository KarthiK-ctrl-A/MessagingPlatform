-- Apply to the existing ClinicalWebApp Supabase database after its clinical
-- schema and messaging-security migrations. Run once as the migration owner.
-- The clinical app uses Supabase Data API and Realtime: keep those enabled.
-- This migration retains public.messages and its authenticated RLS policies.
-- Give messaging_b_runtime a password separately; connect B as this role.
-- An existing messaging_app role is deliberately left untouched.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.profiles') IS NULL
     OR to_regclass('public.patients') IS NULL
     OR to_regclass('public.messages') IS NULL THEN
    RAISE EXCEPTION 'Apply the ClinicalWebApp schema before this migration';
  END IF;
  IF to_regclass('public.conversations') IS NOT NULL THEN
    RAISE EXCEPTION 'public.conversations already exists; review its shape before applying this migration';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.patients p WHERE p.user_id = p.doctor_id
  ) OR EXISTS (
    SELECT 1 FROM public.messages m
    JOIN public.patients p ON p.id = m.patient_id
    WHERE p.user_id = m.doctor_id
  ) THEN
    RAISE EXCEPTION 'A patient and doctor cannot be the same user';
  END IF;
END;
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'messaging_b_runtime') THEN
    RAISE EXCEPTION 'messaging_b_runtime already exists; inspect it before reuse';
  END IF;
  CREATE ROLE messaging_b_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
END;
$$;

GRANT CONNECT ON DATABASE postgres TO messaging_b_runtime;
GRANT USAGE ON SCHEMA public TO messaging_b_runtime;

-- Shared replay claim across all B replicas. Keep internal out of Data API schemas.
CREATE SCHEMA IF NOT EXISTS internal;
GRANT USAGE ON SCHEMA internal TO messaging_b_runtime;
CREATE TABLE IF NOT EXISTS internal.request_nonces (
  request_id uuid PRIMARY KEY,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS request_nonces_expiry
  ON internal.request_nonces (expires_at);
REVOKE ALL ON internal.request_nonces FROM PUBLIC, anon, authenticated;
GRANT INSERT, DELETE ON internal.request_nonces TO messaging_b_runtime;
GRANT SELECT (request_id) ON internal.request_nonces TO messaging_b_runtime;

CREATE OR REPLACE FUNCTION public.current_messaging_actor()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT NULLIF(current_setting('app.user_id', true), '')::uuid;
$$;
REVOKE ALL ON FUNCTION public.current_messaging_actor() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.current_messaging_actor() TO messaging_b_runtime;

-- One conversation per patient/doctor assignment pair. Existing message pairs
-- are retained, including historical doctors; RLS exposes only the current pair.
CREATE TABLE public.conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES public.patients(id) ON DELETE CASCADE,
  doctor_id uuid NOT NULL REFERENCES public.profiles(id),
  user_low uuid NOT NULL REFERENCES public.profiles(id),
  user_high uuid NOT NULL REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT distinct_conversation_users CHECK (user_low < user_high),
  CONSTRAINT one_clinical_conversation UNIQUE (patient_id, doctor_id)
);

CREATE INDEX conversations_user_low_time
  ON public.conversations (user_low, created_at DESC, id DESC);
CREATE INDEX conversations_user_high_time
  ON public.conversations (user_high, created_at DESC, id DESC);

INSERT INTO public.conversations
  (patient_id, doctor_id, user_low, user_high, created_at)
SELECT m.patient_id, m.doctor_id,
       LEAST(p.user_id, m.doctor_id), GREATEST(p.user_id, m.doctor_id),
       MIN(m.created_at)
FROM public.messages m
JOIN public.patients p ON p.id = m.patient_id
GROUP BY m.patient_id, m.doctor_id, p.user_id;

-- Extend the existing table. Old clients may keep inserting patient_id/doctor_id;
-- the trigger below supplies conversation_id and an idempotency UUID for them.
ALTER TABLE public.messages
  ADD COLUMN conversation_id uuid,
  ADD COLUMN client_message_id uuid;

UPDATE public.messages m
SET conversation_id = c.id,
    client_message_id = gen_random_uuid()
FROM public.conversations c
WHERE c.patient_id = m.patient_id AND c.doctor_id = m.doctor_id;

ALTER TABLE public.messages
  ALTER COLUMN conversation_id SET NOT NULL,
  ALTER COLUMN client_message_id SET NOT NULL,
  ADD CONSTRAINT messages_conversation_id_fkey
    FOREIGN KEY (conversation_id) REFERENCES public.conversations(id),
  ADD CONSTRAINT unique_client_message UNIQUE (sender_id, client_message_id);

CREATE INDEX messages_conversation_page
  ON public.messages (conversation_id, created_at DESC, id DESC);

-- Runs for both the existing clinical REST/Data API writer and Server B.
-- It resolves or creates the conversation, fills legacy columns for B, and
-- rejects a stale doctor assignment or mismatched conversation identifiers.
CREATE OR REPLACE FUNCTION internal.prepare_clinical_message()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_patient_id uuid;
  v_doctor_id uuid;
  v_patient_user_id uuid;
  v_conversation_id uuid;
BEGIN
  IF NEW.conversation_id IS NOT NULL THEN
    SELECT c.patient_id, c.doctor_id
      INTO v_patient_id, v_doctor_id
    FROM public.conversations c
    WHERE c.id = NEW.conversation_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Conversation unavailable';
    END IF;
    IF (NEW.patient_id IS NOT NULL AND NEW.patient_id <> v_patient_id)
       OR (NEW.doctor_id IS NOT NULL AND NEW.doctor_id <> v_doctor_id) THEN
      RAISE EXCEPTION 'Conversation identifiers do not match';
    END IF;
  ELSE
    IF NEW.patient_id IS NULL OR NEW.doctor_id IS NULL THEN
      RAISE EXCEPTION 'Patient and doctor are required';
    END IF;
    v_patient_id := NEW.patient_id;
    v_doctor_id := NEW.doctor_id;
  END IF;

  SELECT p.user_id INTO v_patient_user_id
  FROM public.patients p
  WHERE p.id = v_patient_id AND p.doctor_id = v_doctor_id
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Current doctor assignment required';
  END IF;
  IF NEW.sender_id IS NULL OR NEW.sender_id NOT IN (v_patient_user_id, v_doctor_id) THEN
    RAISE EXCEPTION 'Sender is not a conversation participant';
  END IF;

  IF NEW.conversation_id IS NULL THEN
    INSERT INTO public.conversations
      (patient_id, doctor_id, user_low, user_high)
    VALUES (v_patient_id, v_doctor_id,
            LEAST(v_patient_user_id, v_doctor_id),
            GREATEST(v_patient_user_id, v_doctor_id))
    ON CONFLICT (patient_id, doctor_id) DO NOTHING
    RETURNING id INTO v_conversation_id;
    IF v_conversation_id IS NULL THEN
      SELECT c.id INTO v_conversation_id
      FROM public.conversations c
      WHERE c.patient_id = v_patient_id AND c.doctor_id = v_doctor_id;
    END IF;
    NEW.conversation_id := v_conversation_id;
  END IF;

  NEW.patient_id := v_patient_id;
  NEW.doctor_id := v_doctor_id;
  NEW.client_message_id := COALESCE(NEW.client_message_id, gen_random_uuid());
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION internal.prepare_clinical_message() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER prepare_clinical_message_before_insert
  BEFORE INSERT ON public.messages
  FOR EACH ROW EXECUTE FUNCTION internal.prepare_clinical_message();

-- Keep the clinical app's existing authenticated table grants and policies.
-- Give B only the columns and operations its repository uses.
ALTER TABLE public.patients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.conversations FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.conversations TO messaging_b_runtime;
GRANT SELECT (id, user_id, doctor_id) ON public.patients TO messaging_b_runtime;
GRANT SELECT ON public.messages TO messaging_b_runtime;
GRANT INSERT (conversation_id, sender_id, client_message_id, content)
  ON public.messages TO messaging_b_runtime;

CREATE POLICY messaging_b_runtime_patient_read ON public.patients
  FOR SELECT TO messaging_b_runtime
  USING ((SELECT public.current_messaging_actor()) IN (user_id, doctor_id));

CREATE POLICY messaging_b_runtime_conversation_read ON public.conversations
  FOR SELECT TO messaging_b_runtime
  USING (EXISTS (
    SELECT 1 FROM public.patients p
    WHERE p.id = conversations.patient_id
      AND p.doctor_id = conversations.doctor_id
      AND (SELECT public.current_messaging_actor()) IN (p.user_id, p.doctor_id)
  ));

CREATE POLICY messaging_b_runtime_message_read ON public.messages
  FOR SELECT TO messaging_b_runtime
  USING (EXISTS (
    SELECT 1 FROM public.patients p
    WHERE p.id = messages.patient_id
      AND p.doctor_id = messages.doctor_id
      AND (SELECT public.current_messaging_actor()) IN (p.user_id, p.doctor_id)
  ));

CREATE POLICY messaging_b_runtime_message_insert ON public.messages
  FOR INSERT TO messaging_b_runtime
  WITH CHECK (
    sender_id = (SELECT public.current_messaging_actor())
    AND EXISTS (
      SELECT 1 FROM public.patients p
      WHERE p.id = messages.patient_id
        AND p.doctor_id = messages.doctor_id
        AND (SELECT public.current_messaging_actor()) IN (p.user_id, p.doctor_id)
    )
  );

-- B may create a conversation only for an existing patient/current doctor pair.
CREATE OR REPLACE FUNCTION public.create_direct_conversation(p_other_user_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_actor uuid := public.current_messaging_actor();
  v_patient_id uuid;
  v_patient_user_id uuid;
  v_doctor_id uuid;
  v_id uuid;
BEGIN
  IF v_actor IS NULL OR p_other_user_id IS NULL OR v_actor = p_other_user_id THEN
    RAISE EXCEPTION 'Invalid conversation users';
  END IF;
  SELECT p.id, p.user_id, p.doctor_id
    INTO v_patient_id, v_patient_user_id, v_doctor_id
  FROM public.patients p
  WHERE (p.user_id = v_actor AND p.doctor_id = p_other_user_id)
     OR (p.doctor_id = v_actor AND p.user_id = p_other_user_id)
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Recipient is not the current doctor or patient';
  END IF;

  INSERT INTO public.conversations (patient_id, doctor_id, user_low, user_high)
  VALUES (v_patient_id, v_doctor_id,
          LEAST(v_patient_user_id, v_doctor_id),
          GREATEST(v_patient_user_id, v_doctor_id))
  ON CONFLICT (patient_id, doctor_id) DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    SELECT c.id INTO v_id FROM public.conversations c
    WHERE c.patient_id = v_patient_id AND c.doctor_id = v_doctor_id;
  END IF;
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.create_direct_conversation(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_direct_conversation(uuid) TO messaging_b_runtime;

COMMIT;
