# Shared data setup (Supabase)

The app uses Supabase for shared inventory data. The SQL files at this level are retained as a manual setup reference; `supabase/migrations/` is the source of truth for automated deployments.

To make Nhà Ops usable by multiple staff devices:

1. Create a Supabase project in Singapore.
2. Run `001_inventory.sql` in the Supabase SQL Editor.
3. Create a private Storage bucket for invoice images/PDFs.
4. Run `002_shared-account-security.sql` after `001_inventory.sql`.
5. Run `003_inventory_lifecycle.sql` to share expiry, storage and active-package lifecycle across devices.
6. Add `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` to `.env.local` and Vercel environment variables.
7. Create the shared shop account in Supabase Auth before enabling staff access.

The shared-account RLS policy is intentional: anyone who signs in with the shared shop account can manage the same inventory and bills.

## Automatic production migrations

GitHub Actions can apply only new migrations after a push to `main`. It never exposes database credentials to the browser, Vercel, or source control.

1. In the Supabase dashboard, create a Personal Access Token at `Account > Access Tokens`.
2. In the GitHub repository, open `Settings > Secrets and variables > Actions` and add these repository secrets:
   - `SUPABASE_ACCESS_TOKEN`: the Personal Access Token.
   - `SUPABASE_DB_PASSWORD`: the database password selected when the Supabase project was created. This is not the Auth user password.
3. Open `Actions > Apply Supabase migrations > Run workflow`, select `baseline_existing_database: true`, then run it on `main` exactly once. It records the existing manually applied `001` and `002` migrations, then applies `003`.
4. Confirm the run is green. Future changes under `supabase/migrations/` are then applied automatically with each push to `main`.

Do not select the baseline option again. For future changes, add a new timestamped SQL file to `supabase/migrations/` and push it normally.
