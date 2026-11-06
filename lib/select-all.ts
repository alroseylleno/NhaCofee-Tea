/// PostgREST answers at most `max-rows` rows (1000 on Supabase) and says
/// nothing about the rest. A list read in one request silently loses its tail
/// once the table outgrows that: on 06/11/2026 inventory_active_sessions passed
/// 1000 rows, the app stopped seeing the 105 oldest openings, showed their lots
/// as sealed again, and 36 units were opened (and expensed) a second time.
/// Every table that can grow is therefore read page by page.
///
/// `fetchPage` must order by a unique key (add the primary key as the last
/// `.order`) so pages neither overlap nor skip. Paging stops on an empty page
/// rather than on a short one, so a server cap below 1000 cannot end it early.
/// Rows whose `key` was already seen (a row inserted mid-read shifts the pages)
/// are dropped.
type PageError = { code?: string; message: string; details?: string | null; hint?: string | null };
type PageResult<T> = { data: T[] | null; error: PageError | null };
type AllResult<T> = { data: T[]; error: null } | { data: null; error: PageError };

const PAGE_SIZE = 1000;

export async function selectAll<T>(fetchPage: (from: number, to: number) => PromiseLike<PageResult<T>>, key: (row: T) => string = (row) => { const id = (row as { id?: unknown }).id; return id == null ? JSON.stringify(row) : String(id); }): Promise<AllResult<T>> {
  const rows: T[] = [];
  const seen = new Set<string>();
  for (let from = 0; ; ) {
    const { data, error } = await fetchPage(from, from + PAGE_SIZE - 1);
    if (error) return { data: null, error };
    if (!data?.length) return { data: rows, error: null };
    for (const row of data) {
      const id = key(row);
      if (seen.has(id)) continue;
      seen.add(id);
      rows.push(row);
    }
    from += data.length;
  }
}
