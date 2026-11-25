-- Apply after 20261124_clinical_messaging.sql in the existing clinical database.
-- The replay table may have RLS enabled by project policy; give only B the
-- operations it needs. Contact names are limited to current care pairs.
BEGIN;

GRANT SELECT (request_id, expires_at) ON internal.request_nonces TO messaging_b_runtime;
ALTER TABLE internal.request_nonces ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'internal'
    AND tablename = 'request_nonces' AND policyname = 'messaging_b_replay_read') THEN
    CREATE POLICY messaging_b_replay_read ON internal.request_nonces
      FOR SELECT TO messaging_b_runtime USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'internal'
    AND tablename = 'request_nonces' AND policyname = 'messaging_b_replay_insert') THEN
    CREATE POLICY messaging_b_replay_insert ON internal.request_nonces
      FOR INSERT TO messaging_b_runtime WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'internal'
    AND tablename = 'request_nonces' AND policyname = 'messaging_b_replay_cleanup') THEN
    CREATE POLICY messaging_b_replay_cleanup ON internal.request_nonces
      FOR DELETE TO messaging_b_runtime
      USING (expires_at < now() - interval '1 minute');
  END IF;
END;
$$;

GRANT SELECT (id, full_name, role) ON public.profiles TO messaging_b_runtime;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
    AND tablename = 'profiles' AND policyname = 'messaging_b_care_contact_read') THEN
    CREATE POLICY messaging_b_care_contact_read ON public.profiles
      FOR SELECT TO messaging_b_runtime
      USING (
        id = (SELECT public.current_messaging_actor())
        OR EXISTS (
          SELECT 1 FROM public.patients p
          WHERE p.user_id = profiles.id
            AND p.doctor_id = (SELECT public.current_messaging_actor())
        )
        OR EXISTS (
          SELECT 1 FROM public.patients p
          WHERE p.doctor_id = profiles.id
            AND p.user_id = (SELECT public.current_messaging_actor())
        )
      );
  END IF;
END;
$$;

COMMIT;
