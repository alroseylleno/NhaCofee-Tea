-- Ensure PostgREST sees the finance tables and RPCs immediately after the
-- preceding migration is applied. This does not read, update, or delete data.
notify pgrst, 'reload schema';
