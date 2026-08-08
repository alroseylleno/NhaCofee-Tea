# Nha Ops Agent Instructions

- Read `MOC.md` before inspecting or editing code in this project.
- Use the routing table in `MOC.md` to identify every affected UI, store, import/export and Supabase path.
- Preserve unrelated dirty work. Product Master/CFO files may be local work in progress and must not be included in unrelated commits.
- Keep Local/UAT data isolated from Production Supabase.
- Add a new timestamped file under `supabase/migrations/` only when schema, RLS, RPC or Production data changes require it.
- Update `MOC.md` whenever architecture, module ownership, data contracts, migrations, deployment behavior or UAT/Production boundaries change.
- When the user says `update memory`, check whether the work involved Nha Ops; if yes, update `MOC.md` as part of the memory update.
