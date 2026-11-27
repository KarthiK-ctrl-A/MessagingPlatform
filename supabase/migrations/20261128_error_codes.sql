-- Apply after 20261127_fast_message_history.sql in the existing clinical database.
-- Gives every business-rule exception raised by this project's SQL a stable
-- application SQLSTATE so Server B maps failures by code instead of by message:
--   MP400 -> VALIDATION (400), MP403 -> FORBIDDEN (403), MP404 -> NOT_FOUND (404).
-- Function bodies are otherwise unchanged. CREATE OR REPLACE keeps the existing
-- grants, ownership and the trigger binding. Server B also understands the old
-- messages, so B can be deployed before or after this migration.
BEGIN;

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
      RAISE EXCEPTION 'Conversation unavailable' USING ERRCODE = 'MP404';
    END IF;
    IF (NEW.patient_id IS NOT NULL AND NEW.patient_id <> v_patient_id)
       OR (NEW.doctor_id IS NOT NULL AND NEW.doctor_id <> v_doctor_id) THEN
      RAISE EXCEPTION 'Conversation identifiers do not match' USING ERRCODE = 'MP400';
    END IF;
  ELSE
    IF NEW.patient_id IS NULL OR NEW.doctor_id IS NULL THEN
      RAISE EXCEPTION 'Patient and doctor are required' USING ERRCODE = 'MP400';
    END IF;
    v_patient_id := NEW.patient_id;
    v_doctor_id := NEW.doctor_id;
  END IF;

  SELECT p.user_id INTO v_patient_user_id
  FROM public.patients p
  WHERE p.id = v_patient_id AND p.doctor_id = v_doctor_id
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Current doctor assignment required' USING ERRCODE = 'MP403';
  END IF;
  IF NEW.sender_id IS NULL OR NEW.sender_id NOT IN (v_patient_user_id, v_doctor_id) THEN
    RAISE EXCEPTION 'Sender is not a conversation participant' USING ERRCODE = 'MP403';
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
    RAISE EXCEPTION 'Invalid recipient' USING ERRCODE = 'MP400';
  END IF;
  SELECT p.id, p.user_id, p.doctor_id
    INTO v_patient_id, v_patient_user_id, v_doctor_id
  FROM public.patients p
  WHERE (p.user_id = v_actor AND p.doctor_id = p_other_user_id)
     OR (p.doctor_id = v_actor AND p.user_id = p_other_user_id)
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invalid recipient' USING ERRCODE = 'MP400';
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

COMMIT;
