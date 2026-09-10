# Nha Ops - Code Map

> Last reviewed: 2026-09-10
> Production branch: `main`
> GitHub: `alroseylleno/NhaCofee-Tea`

This is the mandatory routing map for code changes in `Operations/nha-ops/`. Read it before editing. Update it whenever a change adds a module, moves ownership between files, changes a data contract, adds a Supabase migration, or changes the UAT/Production boundary.

## Current State

- Reconciliation covers ALL THREE sàn as of 2026-09-10 (build R26). ShopeeFood ("ShopeeFood Partner - Báo cáo doanh thu hàng ngày" from no-reply@shopeefood.vn, CSV attached only on days with orders — the "(Mart)" twin mail never has one) and GreenSM ("Báo cáo doanh thu" from no-reply@greensm.com, xlsx, mailed only on days with revenue) are parsed by `parseShopeeIncomeCsv`/`parseGreenRevenueRows` in `lib/grab-report.ts` and NORMALISED INTO the ParsedGrabReport shape with a `platform` tag ("grab" | "shopee" | "greensm", matching `marketplaceKey`), so the entire matching/đối soát/journey/Supabase pipeline is reused unchanged. Shopee identity: Thực thu = Giá trị − KM quán − Chiết khấu − Thuế (ship-to-shop mapped as negative shippingSupport); GreenSM: merchantPromo is derived as Giá trị − Doanh thu ròng, then Thực thu = ròng − Chiết khấu − VAT − PIT. Migration `20260910000100` adds `platform` (default 'grab') to `finance_grab_reconciliations` + `finance_grab_daily_reports` and replaces UNIQUE(report_date) with UNIQUE(platform, report_date); the daily upsert conflicts on "platform,report_date". `fetch-grab-reports.mjs` sweeps all three senders in one IMAP session into `Report/Grab Report|Shopee Report|GreenSM Report/`; `/api/grab-reports` parses all three folders; the manual upload input accepts .pdf/.csv/.xlsx. Seeded + verified on Production 2026-09-10: 11/11 Shopee+GreenSM orders matched `exact`.
- Production `main` is `69633fb` (2026-09-09): the prod-door release, build stamp R25. Three fixes behind one symptom (Production scans wrote nothing): (1) `app/page.tsx` — on dev servers `DEFAULT_LOCAL_UAT` is true and the hostname effect could only turn UAT ON, so `prod.localhost` had NEVER actually been Production; an explicit OFF branch for `*.localhost` (plus clearing the UAT login prefill) makes the door real. (2) `replace_finance_counter_prices` failed remotely with `21000 DELETE requires a WHERE clause` — Supabase API sessions run safeupdate, rejecting WHERE-less DELETEs even inside security-definer RPCs; migration `20260908000100` adds the WHERE and `lib/finance-store.ts` keeps a filtered-delete+insert fallback on code 21000. (3) `scripts/export-sapo-reports.mjs` `chooseRadio` now scores real `input[type=radio]` elements by ancestor text (captions sit on the input's grandparent and duplicate the list tabs behind the dialog); the nightly invoice export grew from one page (50 invoices, 29KB) to full history (1109 invoices, 337KB). `2adf2ab` additionally shows a pointer to prod.localhost on Vercel where the scan button would be.
- Production data seeded 2026-09-09 by a Playwright run logging into `prod.localhost:3001` with the script account and pressing the scan button: 196/198 Grab orders matched. Verified by direct REST counts — 217 `finance_platform_order_rows`, 196 `finance_grab_reconciliations`, 48 `finance_counter_prices`, 51 `finance_grab_daily_reports`, 365 `finance_revenue_rows`. Unmatched, awaiting manual đối soát: GF-007 (02/07), GF-598 (25/08).
- Migrations reach the remote automatically: `.github/workflows/supabase-migrations.yml` runs `db push` when migrations change on `main` (it applied `20260908000100` within minutes of the push). The CLI is ALSO linked locally since 2026-09-09 (`npx supabase login` + `link`, project `xchriunljansnuxcpwic`; `migration list` 39/39 in sync), so manual pushes work too. Verify schema fixes behaviorally (call the real RPC with real rows), never by trusting CLI/history messages.
- Production `main` is `dade1dc` (2026-09-07): the platform-reconciliation release — seven commits from `fb6af78` to `dade1dc` shipping the sàn đối soát feature, its Supabase schema, the Production un-gating and the prod.localhost local-scan path. Confirmed pushed (origin/main matches) and the three reconciliation migrations verified applied on the remote via REST probes.
- Production deploy: Vercel tracks `main`; a normal Git push should redeploy the existing Vercel project.
- Earlier release context: `9a52d3d` (14/08) shipped Product Management/Finance Reports with migration `20260813000200`.
- Production inventory and finance Excel imports use Supabase.
- Localhost and `-uat` hosts use isolated browser storage for UAT inventory. They must not write to Production Supabase.
- Product Master is available in both Local/UAT and Production. UAT uses isolated browser storage; Production reads and writes the shared Supabase Product Master tables.
- Production `main` includes `bc5c225`, which reconciles Product Master ingredients to current Kho NVL source lots after an inventory reset/re-import.
- The current release groups Kho/Active/Used/Waste cards by purchase month, then Category. Month headers are `+` / `-` accordions, while each ingredient detail keeps its complete cross-month receipt history.
- `Đang dùng` mirrors Kho filtering with status cards, Category chips, search, month-open filter, sorting and month → Category accordions. Period settlement offers either returning the opened remainder to Kho or atomically carrying it into one continued active session in the next accounting month while preserving the original shelf-life clock; Production uses `settle_inventory_period_with_carry` from migration `20260813000100`.
- UAT carry-over derives the next accounting month from the selected settlement end date, not the source session's prior recognition month; month arithmetic uses JavaScript's zero-based month index correctly, so an August settlement always carries into September.
- The Kho NVL report workspace is dashboard-first instead of an Excel/table frame: filtered KPIs, six-month purchase value, Category stock concentration, supplier spend and 14-day expiry actions visualize the same inventory dataset.
- The current release adds manual-expense Excel round-trip and Production Supabase persistence through `finance_expenses`; UAT expense records remain browser-local. Production saves require a returned Supabase row before the UI accepts the change.
- All UI date values, date-entry fields and exported Excel date columns use `dd/mm/yyyy`; application state and Supabase continue using ISO `yyyy-mm-dd` internally for safe filtering and persistence.
- Product Master remains Finance-driven for imported SKU/name/category/default-price data, while manual products and clones are also supported in both environments. Production stores those manual products in Supabase and Finance reconciliation preserves them.
- Local/UAT Product Master seeds missing recipes by Finance SKU from `Copy of BẢNG TỔNG HỢP CT (1).xlsx`. Size-specific SKUs use the workbook's M/L column; matched Ingredient Master rows are prefilled, while missing/ambiguous NVL or unsupported conversions remain explicit `CT Excel` flags and block theoretical COGS. Existing saved recipes are never overwritten. Production is unchanged.
- Production migration `20260812000200` corrects the owner-confirmed July overstatement for 9 boxes of Kem béo CARNATION EXTRA in the 48-box receipt `010726-027`. It verifies 16 total lifecycle rows and 13 July rows for that exact receipt, preserves the first 4 legitimate July issues, the two lifecycle rows from other periods and the single active August box, then snapshots and deletes only the latest 9 closed July rows; guarded sealed stock moves from 32 to 41.
- **Platform reconciliation is LIVE in Production as of 2026-09-07.** The `Nền tảng` tab, the three-file SAPO import (invoice list with items + price book), browser PDF ingest and đối soát now run in both modes; Production persists everything through Supabase (`finance_platform_order_rows.items`, `finance_grab_reconciliations`, `finance_grab_daily_reports`, `finance_counter_prices`, `replace_finance_import_bundle_v2`, `replace_finance_counter_prices`). The old `bd46caa` gates are removed. One press of `Quét thư mục local` now runs the whole intake: newest SAPO trio from disk through `importFinanceWorkbooks` (the same path as manual upload, Production persists via RPC), then the Grab PDFs matched against the just-imported orders and price book. The nightly reminder presses Sapo's export buttons and harvests the mails before the dialog when `SAPO_EMAIL` is configured. The button and `/api/grab-reports`/`/api/sapo-reports` routes work on any local host — `http://prod.localhost:3001` runs the PRODUCTION data mode from the local dev server, so a folder scan there writes straight to Supabase (button labelled `→ ghi Production`) — true only since `69633fb`; before that fix the page silently stayed UAT and the scans landed in localStorage. Vercel builds still 403 the route. The dedicated Supabase script account exists as of 2026-09-08 (`GRAB_SUPABASE_EMAIL`/`GRAB_SUPABASE_PASSWORD` in `.env.local`, plain `authenticated` role under RLS), so `grab:prod`/`sapo:prod` no longer have a missing precondition; `grab:uat` completed its first real Gmail pass the same day.
- Sàn means Grab, Shopee, GreenSM, beFood and GoFood — channels that hold the customer's money and settle later. `Website` is an owned channel with no platform fee and no settlement, so it is reported separately under `Kênh khác` and excluded from every sàn KPI, chart and reconciliation list. `isMarketplaceSignal` draws that line; the older `isKnownPlatformSignal` still includes Website and governs only what gets imported.
- Platform fee is not derivable from the SAPO invoice export: `Phí dịch vụ (3)` and `Phí GH thu khách (5)` are `0` on every sàn order. The only truthful sources are đối soát (`SAPO ghi nhận − thực nhận`) and Grab's daily PDF. A sàn with no reconciled order must read *chưa đo được*, never an assumed rate.

## Start Here

| Change requested | Primary file | Supporting files | Data impact |
|---|---|---|---|
| Kho NVL UI, forms, category tabs, inventory cards, active lifecycle, reports | `app/page.tsx` | `app/globals.css` | Check `lib/inventory-store.ts`; add migration only for schema changes |
| Inventory Supabase read/write, receipts, lifecycle sessions | `lib/inventory-store.ts` | `lib/supabase.ts` | `inventory_receipts`, `inventory_history`, `inventory_active_sessions`, Storage bucket `bills` |
| Finance entry, revenue imports, reports, dashboard | `app/finance-module.tsx` | `app/finance.module.css`, `lib/finance-store.ts` | Finance import tables/RPCs; UAT local storage stays isolated |
| Finance Excel persistence and replace-latest logic | `lib/finance-store.ts` | `app/finance-module.tsx` | `finance_imports`, `finance_revenue_rows`, `finance_product_rows`, `finance_service_rows` |
| Product Master, ingredient master, recipes, theoretical COGS | `app/product-master.tsx` | `app/product-master.module.css`, `lib/master-data.ts`, `lib/master-data-store.ts` | UAT browser storage; Production Supabase master and versioned-recipe tables |
| Global mobile shell, login, shared inventory styling | `app/page.tsx` | `app/globals.css`, `public/` | UI-only unless fields/data contracts change |
| Supabase client/environment variables | `lib/supabase.ts` | `.env.local`, Vercel environment variables | Never expose service-role or database credentials in browser code |
| Ingredient master code allocation | `lib/master-data.ts` (`mergeInventoryDrafts`) | `lib/master-data-store.ts` | New `NVL-0000` codes are allocated above the highest running number in use, never from array position. Positional codes collide with surviving rows whenever an `ingredient_master` row is deleted, and the client upsert conflicts on `(store_id, source_key)` so it cannot absorb a clash on `(store_id, code)` |
| Database schema, RLS, RPCs, triggers | `supabase/migrations/` | `.github/workflows/supabase-migrations.yml` | Always add a new timestamped migration; never rewrite an applied migration |
| Deployment/migration automation | `.github/workflows/supabase-migrations.yml` | `supabase/README.md` | Runs only when migrations/workflow change on `main` |
| Sàn settlement parsing — Grab PDF, Shopee CSV, GreenSM xlsx | `lib/grab-report.ts` | `app/finance-module.tsx`, `public/pdf-worker/` | Pure parser; no data impact until the matcher runs |
| PDF↔SAPO matching, đối soát auto-fill, platform dashboards | `app/finance-module.tsx` | `lib/grab-report.ts`, `app/finance.module.css` | Writes `grabReconciliations` and `grabDailyReports`; UAT localStorage only |
| Reading the local Grab PDF folder | `app/api/grab-reports/route.ts` | `next.config.ts` (`serverExternalPackages`) | Dev/UAT only; returns 403 in a production build |
| Downloading sàn reports from Gmail (Grab/Shopee/GreenSM) | `scripts/fetch-grab-reports.mjs` (PLATFORMS config: sender + subject + extension per sàn) | `package.json` (`grab:uat`, `grab:prod`), `.env.local` | Writes into `Report/Grab Report|Shopee Report|GreenSM Report/`; never touches the database |
| Sapo file layout + dated names | `scripts/sapo-files.mjs` (`Report/Doanh thu tổng quan` · `Danh sách hoá đơn` · `Danh mục mặt hàng`; names carry the covered period or the export moment) | `export-sapo-reports.mjs`, `fetch-sapo-reports.mjs`, `app/api/sapo-reports/route.ts` | Pure file organisation |
| Pressing Sapo's export buttons | `scripts/export-sapo-reports.mjs` (Playwright + system Chrome, SSO login, session in `.grab-state/sapo-session.json`; dialog radios picked by ancestor-text scoring — captions duplicate the list tabs, and the invoice scope must be `Tất cả hóa đơn`, never the current-page default) | `package.json` (`sapo:export`, `sapo:daily`), `.env.local` (`SAPO_EMAIL`/`SAPO_PASSWORD`) | Triggers exports only; revenue file downloads straight into `Report/` |
| Serving the newest SAPO trio to the browser | `app/api/sapo-reports/route.ts` | `app/finance-module.tsx` (`importFinanceWorkbooks`) | Dev/UAT only (403 in production builds); read-only |

## Runtime Map

```text
app/page.tsx
  |- Authentication and runtime UAT/Prod detection
  |- Kho NVL state, forms, lifecycle and reports
  |- FinanceModule props from inventory lots/sessions
  `- ProductMaster props in both Local/UAT and Production

lib/inventory-store.ts <-> Supabase inventory tables + bills storage
app/finance-module.tsx <-> lib/finance-store.ts <-> Supabase finance tables/RPCs
app/product-master.tsx <-> lib/master-data.ts <-> lib/master-data-store.ts <-> Supabase Product Master
```

There are no Next.js API routes. The client talks directly to Supabase using the publishable key and relies on Auth plus RLS.

## Kho NVL Map

### `app/page.tsx`

Owns:

- Inventory domain types used by the UI: `Ingredient`, `LotMeta`, `ActiveSession`, history and form types.
- Local UAT seed data and local-storage keys.
- UAT host detection: development, `localhost`, loopback hosts and hostnames containing `-uat`.
- Login shell and module navigation.
- Kho NVL tabs: inventory, active, report.
- Stock/used-up views, category quick filters, search and sorting.
- Inventory view filters include `Chưa quy đổi`: only sealed or currently active lots with no usable conversion; historical `Đã dùng` and `Hao hụt` lots are excluded.
- Inventory card hierarchy is purchase month → Category → grouped ingredient. Opening an ingredient exposes the full receipt history grouped again by month, including lots outside the current card month.
- Category normalization: categories are uppercased and case-only duplicates collapse into one category.
- Add/edit/copy/delete flows, invoice attachment UI, Excel import/export.
- Sealed/active/used/wasted calculations and deletion guardrails.
- Open-for-use flow, cost-recognition month, expiry-after-opening and waste closeout.

When changing an inventory field, inspect all of these paths together:

1. `Ingredient` and `FormValues` types.
2. `safeItems()` compatibility normalization.
3. Add/edit/copy form initialization.
4. `saveIngredient()` and history diff generation.
5. Excel import and Excel export columns.
6. `lib/inventory-store.ts` row mapping.
7. Supabase migration if a new database column is required.
8. Detail drawer and report table display.

### Inventory identity and quantity rules

- A lot is identified by its `id`; receipt code is the human-facing import/update key.
- Product grouping uses normalized name, brand, unit and specification.
- Sealed quantity is total lot quantity minus every unit ever issued to an active session.
- An active session has status `active`, `used`, or `wasted`.
- A lot/receipt cannot be deleted after any unit has been issued, regardless of current active count.
- Fully depleted groups move from `Tồn kho` to `Dùng hết` when sealed quantity and active quantity both reach zero.
- Cost recognition uses `costRecognitionMonth`; operational opening time remains `activatedAt`.
- Local UAT and Production support period settlement for an active converted unit. The session keeps its provisional full cost until settlement, then stores `recognizedCost` for actual use and creates an internal `stockState: opened` return lot for the remaining quantity/value. Production uses the atomic `settle_inventory_period` RPC so closing the session and creating the return lot cannot partially succeed. Internal return lots are inventory assets, not new purchases, and preserve the first-open shelf-life clock.
- `Tiếp tục dùng tháng sau` closes the current period, creates the same internal opened remainder lot, then consumes that lot into one new active session whose `costRecognitionMonth` is the following month. The physical package count stays unchanged. Production uses the atomic `settle_inventory_period_with_carry` RPC, so the original close, internal return lot and new active session either all commit or none do.

## Finance Map

### `app/finance-module.tsx`

Owns expense forms, period filters, Excel parsing, report/dashboard calculations and inventory-linked COGS/waste views. Current tabs are expense entry, revenue, financial report and dashboard.

Important boundaries:

- UAT finance data uses UAT-specific browser storage.
- Production manual-expense cache uses `nha-ops-finance-v2`; the prior `v1` and accidental legacy-UAT fallback are cleared so a database inventory reset cannot leave stale expense cards in the browser.
- Manual expenses use Excel export/import with stable record IDs and an exported instruction sheet. Duplicate IDs inside one workbook keep the final row. UAT merges imported rows into its isolated browser store; Production bulk-upserts them into `finance_expenses`, requires Supabase to return every imported row, then reloads and verifies the committed cloud snapshot.
- Expense entry keeps the four expense-category filter cards. Inside the selected filter, record groups are `+` / `-` accordions by manual subcategory; Operating expenses also contain `Từ Kho NVL`, nested again by the Category carried from each inventory lot before showing individual COGS/waste events.
- Every `Tài chính → Báo cáo tài chính` workspace (P&L, Cash Flow, Inventory and Assets/Depreciation) uses the same parent → subcategory → line-item accordion hierarchy with counts and `+` / `-`. Revenue/calculated totals use explicit composition subgroups; inventory and assets group by their source Category/subcategory.
- Each Financial Report workspace also has a responsive dashboard above its accordion: P&L shows net revenue/profit KPIs and cost mix, Cash Flow shows inflow/outflow/net cash and outflow mix, Inventory shows opening/closing/issued values and closing Category concentration, and Assets shows original/accumulated/remaining values plus asset-category concentration.
- `Tài chính → Doanh thu` has a third subtab, `Nền tảng`, for platform/channel dashboards and GRAB order reconciliation. The Import Center treats the SAPO bundle as four files: Revenue overview, Product catalog, Service type and Invoice list. Invoice rows keep all external-platform orders (GrabFood, Website, ShopeeFood, Green Food, etc.) in `platformOrders`/`finance_platform_order_rows`, powering platform revenue, order/AOV, discount, cancellation, channel-mix and daily-trend dashboards. GRAB reconciliation remains order-level: the user selects an unreconciled SAPO order and enters only actual received cash plus an optional note. UAT stores reconciliation in isolated browser state; Production stores it in `finance_grab_reconciliations` through authenticated Supabase CRUD.
- On the first successful Production load after the expense migration, each device uses `nha-ops-finance-expenses-migrated-v1` to insert its browser-cached v2 expenses only once. Existing cloud IDs are never overwritten, and later cloud deletions cannot be resurrected by the cache.
- Production Excel imports load from and replace the latest matching datasets in Supabase.
- Importing a new dataset replaces that dataset through database RPCs; it must not silently clear unrelated inventory or expense data.
- Inventory costs use sessions and their recognition month, not merely the browser's current month.

### Grab daily report ingest

Two entry points, one shared tail. `importGrabReportPdf` (file picker, parses in the browser via `pdfjs-dist` with the worker served from `public/pdf-worker/`) and `scanLocalGrabReports` (reads `/api/grab-reports`, which parses server-side with the pdfjs legacy build) both hand off to `applyGrabReports`, so matching and state folding exist in exactly one place.

Matching rule, verified against a real report: **`SAPO Tổng tiền thanh toán = Grab Trị giá đơn hàng − Khuyến mãi từ người bán`**. When several SAPO orders share that amount, the winner is the one whose creation time sits closest before the PDF's delivery time. Unmatched PDF orders are recorded on the daily report row rather than dropped silently.

Grab charges advertising per day, not per order, so `marketingAllocated` spreads the day's marketing total evenly across that day's orders. Any per-order marketing figure in the UI is that allocation, never a Grab-supplied number.

The automatic folder scan runs once per session when the `Nền tảng` tab first opens, and skips any report date already ingested from the same file name — so it can never overwrite a reconciliation edited by hand.

Counter price (`So giá quầy`) defaults to `giá Grab × 0,7278` and is editable. It is an estimate, not a lookup: the SAPO invoice export carries no line items, so a basket cannot be priced against Product Master automatically.

### `scripts/fetch-grab-reports.mjs`

Manual trigger that pulls Grab's daily PDFs out of Gmail over IMAP using an App Password, into `Report/Grab Report/`. Two npm scripts split the destinations deliberately: `grab:uat` writes to disk for the browser to ingest, and `grab:prod` refuses to run until the reconciliation migrations are applied, the `Nền tảng` tab is un-gated for Production, and a dedicated Supabase account exists for the script. Keeping them separate means a routine UAT refresh has no code path to production data.

The mail must satisfy all three of: from `no-reply@grab.com`, subject containing `Báo cáo doanh số`, and a PDF attachment. Only the sender and date range go to IMAP `SEARCH`; the Vietnamese subject is matched in code accent-insensitively, because Gmail needs a UTF-8 charset negotiation for non-ASCII `SEARCH` terms and returns an empty result — not an error — when it goes wrong. The mailbox is resolved by its `\All` special-use flag rather than the literal `[Gmail]/All Mail`, whose name is localised.

Production ingest must not put a Supabase `service_role` key on Vercel: `.github/workflows/supabase-migrations.yml` states that secrets live only in GitHub Actions, and `service_role` bypasses RLS entirely. Use a dedicated authenticated account instead.


### `scripts/export-supabase-cogs.mjs`

Read-only dump of the Product Master/COGS tables (`stores`, `ingredient_master`, `product_master`, `product_recipe_versions`, `product_recipe_items`, `product_catalog_exclusions`, `finance_counter_prices`) into `.grab-state/supabase-export/*.json` (gitignored). Run with `npm run cogs:export`. Auth uses `GRAB_SUPABASE_EMAIL`/`GRAB_SUPABASE_PASSWORD` from `.env.local` (dedicated script account `nhacoffee1211+script@gmail.com`, created 2026-09-08 via the signup API with the publishable key and confirmed through the Grab-report mailbox over IMAP); falls back to an interactive prompt with masked password. Pagination orders by `id` and retries without ordering on a 42703, because two finance tables lack `created_at`. Theoretical COGS is then recomputed offline by mirroring `recipeVersionCost()` — items with `component_type != 'packaging'` join `packagingItems`, prepared components scale by `output_quantity`, and unit conversion follows `unitFactors`.

### `lib/finance-store.ts`

Maps Supabase rows into manual expenses, revenue, product and service records; upserts `finance_expenses`; and calls replace-import RPCs. If an import fails with missing table/function/schema cache errors, verify migrations before changing UI parsing.

## Product Master

The following files implement Product Master. Local/UAT remains isolated in browser storage, while Production uses the Supabase persistence adapter:

- `app/product-master.tsx`
- `app/product-master.module.css`
- `lib/master-data.ts`
- `lib/master-data-store.ts`
- `supabase/migrations/20260805000100_cfo_master_data_foundation.sql`
- Integration edits also overlap `app/page.tsx`, `app/globals.css` and `app/finance-module.tsx`; use partial staging for unrelated fixes instead of staging these whole files.

Current UAT data contract:

- Product Master is rendered in Local/UAT and Production. Production uses `lib/master-data-store.ts` and Supabase.
- UAT browser storage uses `nha-ops-master-data-uat-v5`. Its first load intentionally discards every legacy Product/recipe/cost record, while Ingredient Master continues to rebuild from current Kho NVL.
- Finance product imports reconcile Product Master exactly by normalized SKU in both modes: missing Finance SKUs are created, matching SKUs refresh name/category/variant, and SKUs absent from the latest Finance snapshot are removed with their recipes.
- Selling price defaults from the Finance `Giá mặt hàng` column; an edit may override it, and manual products/clones can be created with their own SKU. Finance reconciliation refreshes imported products but preserves manual products and price overrides.
- Kho NVL lots feed Ingredient Master automatically with currently usable quantity, explicit conversion, operational source price and a source-lot link for traceability. Product Master availability is sealed stock plus lifecycle sessions whose status is `active`; sessions closed as `used` or `wasted` are excluded. Supabase sync is source-of-truth: a master row no longer represented by a current Kho NVL lot is retained only for recipe history, set to inactive with zero availability, and excluded from new recipe choices.
- The recipe cascade offers only active current-inventory master rows with usable quantity greater than zero: Category is sourced from rows that are either still sealed in Kho NVL or currently in `Đang dùng`, then the ingredient/brand picker is constrained to the selected Category. Inactive, depleted, used-up or wasted historical rows remain resolvable by saved recipes but are never selectable for new recipe items.
- Ingredient Master has no manual activation queue. Inventory ingredients become available to new recipe items while they have sealed stock or an active lifecycle session; a saved recipe that later has neither raises a replacement alert explaining that it may be depleted, used up or wasted, and cannot be saved as a new version until the ingredient is replaced or removed.
- Ingredient/brand choices show the latest Kho NVL purchase month as `M/YYYY`. The custom picker closes from its `+` / `-` trigger, after selection, on outside click, on Escape and whenever the product detail context changes; the remaining Product Master dropdowns use native select behavior.
- Multiple lots with the same name, category and brand are aggregated. Conversion and theoretical price use one consistent operational source: the oldest active lot first, otherwise the oldest sealed lot (FIFO). Editing that source lot refreshes active-session quantity/unit/provisional cost and Product Master instead of mixing conversion from one lot with price from another.
- In every environment, a new recipe or packaging item may use only the NVL's explicit `Quy đổi sử dụng` unit. NVL without a valid conversion unit is excluded until its Kho NVL conversion is completed; purchase/base-unit fallback is forbidden because it can hide invalid COGS. Count conversions include `tờ`.
- Recipe edits stay only in the open screen until saved. `Lưu công thức` automatically creates the next immutable version and archives the prior version; there is no recipe activation action.
- Product detail uses progressive saving: price, recipe rows and packaging rows can be saved independently even while other data is missing, unavailable or cannot yet produce theoretical COGS. Missing price/NVL/unit data remains a non-blocking quality warning and keeps cost/margin in `Chưa đủ`; it must not prevent saving the data already entered.
- A manual SKU whose Category normalizes to `Bao Bì` can be a reusable packaging template. Its saved `Bao bì` rows are copied as a snapshot into another product's current packaging draft when selected; legacy template SKUs that store their components in `Nguyên liệu` are also supported. Choosing a template replaces the existing draft only after confirmation, then the copied rows remain editable and save as the destination product's own recipe version. This stays browser-local in UAT and requires no Supabase schema change.
- The parent page memoizes the Product Master inventory projection, and inventory refreshes must not clear the selected SKU or open recipe draft. Closing a product detail or changing saved recipe versions while a draft or quantity entry is unsaved requires explicit confirmation so incidental parent renders, backdrop clicks or version changes cannot discard data entry.
- The UAT navigation label is `Sản phẩm`. It has three workspaces: Overview dashboard, waiting queue, and the combined Product/COGS catalog. The standalone Ingredient tab is intentionally removed; ingredients remain internal recipe choices sourced from Kho NVL.
- Every Finance SKU is normalized to `active` automatically. SKU and recipe activation are not user workflows; saved recipes use the newest version automatically while prior versions remain archived for history.
- The Overview dashboard combines theoretical COGS, gross-margin and inventory-capacity metrics with horizontal Top 5 charts for highest-cost and lowest-cost products, plus Top Items and Top Categories from the latest Finance product import.
- The waiting queue is inventory-driven: an ingredient with neither sealed stock nor an active lifecycle session is flagged with available replacement candidates from the same category and compatible unit family. Product recipe rows expose the same direct `Thay thế` action when an ingredient is red/unavailable.
- The waiting queue is grouped by the same Finance Category and uses compact 1–2 line SKU rows. It includes missing recipes, missing selling price, unit mismatch and depleted/used/wasted NVL replacement alerts.
- Product Alias and workbook/reference-cost concepts are removed. Product detail is one ordered workspace: Overview, Formula & NVL, then History. Formula is a `+` / `-` parent group with three child groups: Selling price, Ingredients and Packaging. Ingredients and Packaging each use the same inventory recipe flow (category, ingredient/brand, converted quantity, unit and waste); the single `Lưu công thức` action persists them with any selling-price edit. Overview explicitly shows `Giá NVL + Bao bì` for total COGS and recalculates profit margin; the compact line chart recalculates every saved recipe version from current Ingredient Master prices.
- Replacing or deleting an unavailable ingredient, or adding a new ingredient, updates the open local recipe draft only. Saving is the single action that creates the new formula version.
- Product and theoretical COGS now share one catalog. Each recipe calculates an estimated serving capacity from currently usable inventory (sealed stock plus active lifecycle sessions); the minimum ingredient capacity is the limiting number of cups.
- Kho NVL category quick filters display the number of matching grouped ingredients after the current stock-state and search filters are applied. A custom Category remains uppercase while typing and accepts spaces; all `Khác` inputs preserve user-entered spaces and normalize only when persisted where applicable.
- Product, ingredient and recipe changes append browser-local audit events for UAT traceability.
- The UAT Product reset control clears only Product recipes/cost history and immediately rebuilds SKU/category/price from the local Finance snapshot; Production exposes no reset control.
- UAT recipe workbook mapping lives in `lib/uat-recipe-workbook.ts`; it is keyed by Finance SKU, resolves live Ingredient Master IDs at runtime and runs again after Finance/Kho sync for missing/workbook-seeded recipes, while any manually saved active version is preserved.
- Recipe versions may carry UAT import metadata (`source`, `sourceLabel`, `expectedItemCount`, `importIssues`). Any unresolved workbook issue or incomplete expected item count prevents theoretical COGS from being presented as complete.
- The Product tab is labelled `Quản lý sản phẩm`. Every product row/card provides Copy and the workspace exposes `Tạo sản phẩm`; UAT stores manual drafts locally and Production persists them in Supabase.
- Product Categories in `Quản lý sản phẩm` are `+` / `-` accordions. Row/card actions use compact Copy and Delete controls. Deleting a Finance-origin SKU records an environment-specific exclusion/tombstone so reconciliation does not immediately recreate it; UAT Reset clears local exclusions.
- Ingredient selection includes `Khác` for formula exceptions that deliberately do not use a Kho NVL conversion. They retain their typed name and explicit manual COGS, which is included in total product COGS and margin. Migration `20260813000200` adds the component discriminator/manual fields required to persist these and Packaging items in Production.
- Count-family recipe units include `trái`, `miếng`, `muỗng` and `vá` so workbook topping quantities can be represented when the matching Kho NVL conversion is count-based.

The intended chain is:

```text
Kho NVL lots -> Ingredient Master -> Recipe quantities -> Theoretical product COGS
Finance product imports -> Product Master -> Product profitability
```

Do not stage these files in an unrelated Kho NVL hotfix. Production Product Master changes must keep the Supabase persistence adapter, RLS scope, Finance integration and UAT isolation aligned.

## Supabase Map

| Area | Tables/functions | Key migrations |
|---|---|---|
| Inventory receipts/history | `inventory_receipts`, `inventory_history` | `20260701000000`, `20260701000001` |
| Inventory import date correction | one-time 09 Aug Excel timezone correction | `20260809000400` - guarded correction of supplied `010726-001..088` codes (without `033`) from 30 Jun to 1 Jul 2026 |
| Inventory Excel import | atomic receipt and history import; prevents partial workbooks | `20260809000500` |
| July 2026 sealed-stock cleanup | destructive one-time Production cleanup; retains active/used/wasted lifecycle rows | `20260809000600` |
| Unbranded sealed-stock cleanup | destructive one-time Production cleanup across all dates; retains lifecycle rows | `20260809000700` |
| June-August 2026 inventory reset | destructive owner-requested Production reset by `purchased_on`; privately snapshots then removes receipts, history, all lifecycle statuses and daily sequences | `20260809000800` |
| Production inventory period settlement | receipt/session settlement fields plus atomic `settle_inventory_period` RPC and opened return lots | `20260809000900` |
| Full Production inventory reset | destructive owner-requested private snapshot followed by complete removal of all receipts, history, lifecycle statuses and daily sequences | `20260809001000` |
| Product Master ingredient reconciliation | marks rows orphaned by a full inventory reset inactive and zero-stock; browser sync restores current receipt links and current Category/name/brand data | `20260809001100` |
| Inventory lifecycle | `inventory_active_sessions`; expiry/storage fields | `20260728000000` |
| Inventory deletion guardrails | authenticated-user RLS, active-session FK behavior and return-to-stock deletion | `20260728000100`, `20260808000200`, `20260809000100`; targeted receipt restoration `20260809000300` |
| Receipt codes | receipt code column, daily sequence, trigger | `20260728000200` |
| Historical test cleanup | destructive one-time cleanup | `20260728000300` |
| Finance imports | finance import/row tables and replace RPCs | `20260804000100` through `20260804000300` |
| Manual finance expenses | `finance_expenses` with explicit authenticated table grants and authenticated CRUD RLS | `20260811000100` |
| Sàn order reconciliation | `finance_grab_reconciliations` with authenticated CRUD RLS, plus `discounts` (layered discount stack), `settlement` (Grab PDF snapshot) and `counter_price` | `20260814000100` |
| SAPO platform invoice detail | `finance_platform_order_rows`, four-file atomic import RPC, import metadata and authenticated CRUD RLS; used by platform dashboards and the GRAB picker | `20260815000100` |
| Grab daily report ledger | `finance_grab_daily_reports`, one row per imported PDF with day-level marketing lines and unmatched orders | `20260814000100` |
| Cost recognition month | `inventory_active_sessions.cost_recognition_month` | `20260805000200` |
| Inventory conversion | conversion amount/unit fields | `20260807000100` |
| CFO master-data foundation | stores, masters, recipes and finance facts | `20260805000100`, `20260809000200` - additive tables, versioned recipes and broad authenticated RLS during rollout |
| Finance-driven Product catalog reset | `finance_product_rows.selling_price`, Product price override, exact Finance reconciliation, one-time Product/Ingredient reset | `20260812000100` |
| Product Management component persistence | `product_recipe_items.component_type`, manual component cost/name fields, Product catalog exclusions and guarded Product delete RPC | `20260813000200` |
| Product Master packaging conversion sync | persists `ingredient_master.conversion_unit`, recalculates linked receipt unit cost, refreshes active session snapshots and corrects CM-M Giấy chống tràn to `tờ` | `20260816000100` |
| July CARNATION EXTRA cost correction | exact receipt `010726-027`; verifies 16 total/13 July rows, preserves 4 legitimate July issues, 2 other-period rows and 1 active August box, then snapshots/deletes the latest 9 closed July excess rows; sealed stock 32 -> 41 | `20260812000200` |
| Snack nhỏ 1.700 / COCA 5.200 total erasure | destructive owner-requested erasure of both lots and every attached record: recipe components, lifecycle rows in all three statuses with their cost recognition, history, receipts and `ingredient_master` rows. Deliberately overrides the Product Master Sync Rule — the owner asked for full erasure, so ingredient rows are deleted outright instead of being kept inactive, and `product_recipe_items` built on them are deleted because `product_recipe_items_source_check` forbids detaching an item from its ingredient. Matches on ASCII `snack`/`coca` plus exact `unit_cost` so mixed NFD/NFC names cannot cause a silent miss. Aborts if either lot is missing, if more than 4 receipts match, or if a settled session or external return lot depends on them. Snapshots into both `private.snack_coca_removal_backups` and `private.inventory_reset_backups` | `20260905000100` |
| Ingredient master restore for surviving lots | repairs `20260905000100`. `ingredient_master` is keyed by `source_key` = (name, category, brand), not by lot, so deleting the row of an erased lot orphaned `Bánh snack - nhỏ`, which still has lot `010726-041` at 5.000. Production then failed to open Quản lý sản phẩm with `23505` on `ingredient_master_store_id_code_key`, because `mergeInventoryDrafts` codes a new draft by array position (`ingredientCode(merged.length)`) and the client upsert targets `(store_id, source_key)`, which cannot absorb a clash on the separate `(store_id, code)` index. Restores from the snapshot only ingredient rows whose name still matches a live receipt, detached and inactive, so the next load re-links them. `Nước ngọt COCA` is not restored and stays erased | `20260905000200` |

Migration rules:

- Add a new timestamped SQL file for every schema/RLS/RPC/data migration change.
- Never edit an already-applied migration to represent a new change.
- Never add a migration for a UI-only change.
- Flag destructive SQL clearly and verify its exact Production scope before push.
- GitHub Actions uses Supabase CLI `2.111.0`; the pin avoids the known `2.112.0` link regression.

## UAT vs Production

| Concern | Local/UAT | Production |
|---|---|---|
| Inventory store | Browser-local isolated keys | Supabase |
| Product Master | Browser-local `nha-ops-master-data-uat-v5`; legacy Product data reset once | Shared Supabase Finance-driven master, recipe-version and audit tables |
| Finance sample data | UAT-only local keys | Must not load UAT samples |
| Manual expense ledger | Browser-local UAT key; Excel can move test data between browsers | Shared `finance_expenses` table after migration `20260811000100` |
| Authentication | Local UAT credentials are prefilled in the local login | Supabase Auth account |
| Reset/sample controls | Allowed | Forbidden |
| Delete receipt / return active unit to stock / period settlement | Allowed in local data | Any authenticated account; receipt deletion remains blocked after its first issue, RLS only permits deleting an `active` session to return it to stock, and period settlement runs atomically through Supabase |
| Excel import | Local update for UAT testing | Supabase persistence for shared data |
| Deployment | Localhost or `-uat` Vercel project | Vercel project tracking `main` |
| Platform orders + đối soát | Browser localStorage, seeded with UAT samples | Supabase-backed: cloud load restored, manual and PDF đối soát upsert `finance_grab_reconciliations` + `finance_grab_daily_reports` before the UI updates |
| Grab PDF ingest | File upload and local folder scan | File upload works and persists to Supabase; the folder scan button is hidden and `/api/grab-reports` still returns 403 in a production build |

Any change touching runtime detection, storage keys, imports or seed data must be tested in both modes. Production must never inherit UAT sample/reset behavior.

## Verification Checklist

Before a local handoff:

1. Run `npm run build`.
2. Test the changed flow at `http://localhost:3001/` when the UAT server is running.
3. Verify mobile widths, especially forms, quick filters, cards and financial KPI boxes.
4. Confirm local UAT changes do not call Production Supabase.

Before pushing `main`:

1. Review `git status` and preserve unrelated dirty work.
2. Stage only files in the approved scope.
3. Run `git diff --cached --check` and inspect the staged diff.
4. If schema changed, include and review a new migration; otherwise include no SQL.
5. Run `npm run build`.
6. Push `main`, then confirm Vercel deployment and migration workflow when applicable.
7. Do not delete or reseed Production data unless Long explicitly requests the exact destructive action.

## MOC Maintenance Rule

When Long says `update memory`:

1. Determine whether the conversation or completed work touched `Operations/nha-ops/`.
2. If yes, update this file with the new commit/status, routing, data contract, migration or guardrail.
3. Also update the Nhà Coffee project memory and Context session/update log.
4. If no Nha Ops behavior, architecture or status changed, record that the MOC was checked and required no content change.
