# Shared data setup (Supabase)

The current app deliberately remains browser-local until a Supabase project is supplied. This avoids pretending that client-side storage is shared data.

To make Nhà Ops usable by multiple staff devices:

1. Create a Supabase project in Singapore.
2. Run `001_inventory.sql` in the Supabase SQL Editor.
3. Create a private Storage bucket for invoice images/PDFs.
4. Run `002_shared-account-security.sql` after `001_inventory.sql`.
5. Run `003_inventory_lifecycle.sql` to share expiry, storage and active-package lifecycle across devices.
6. Add `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` to `.env.local` and Vercel environment variables.
7. Create the shared shop account in Supabase Auth before enabling staff access.

The shared-account RLS policy is intentional: anyone who signs in with the shared shop account can manage the same inventory and bills.
