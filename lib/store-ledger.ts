import type { CloudStore } from "./inventory-store";
import { foldSignal } from "./store-scope";

// Where every inventory lot was on any date, rebuilt from the history lines
// that transfer_inventory (and its UAT mirror applyTransferLocally) writes on
// every transfer. Finance needs it for per-store opening/closing stock, for the
// purchase of each kho and for the "nhận / chuyển kho" lines.
//
// The current row of a lot only knows where the lot is NOW: a whole-lot move
// overwrites store_id and transferred_on, and a merge back deletes the child.
// The history keeps the rest:
//   move   — moved lot, field "store":   from "<kho>",          to "<kho> · dd/mm/yyyy"
//   split  — source,    "quantity" + "transfer": from "<kho>",  to "<kho> · 3 gói · dd/mm/yyyy"
//   child  — new lot,   "transfer" on "created": from "<kho> · <mã>", to "<kho> · … · dd/mm/yyyy"
//   remainder piece ("-LE-") — "piece" on "created": to "Còn lại … · dd/mm/yyyy"
//   merge  — parent,    "quantity" + "transfer": from "<kho> · <mã con>", to "Gộp lại <kho> · dd/mm/yyyy"
//
// History tells WHERE and WHEN, never HOW MUCH: a lot edited after a transfer
// (1 thùng re-entered as 22 cây at a new unit cost, a deleted child whose
// quantity was typed back by hand) makes the quantities in old lines
// meaningless. Values are therefore always today's lot value at the moment the
// location changes, the same numbers the stock snapshot uses, so a store's
// opening + purchases + transfers − issues equals its closing exactly.
//
// Store names are matched against today's names (exact, then containment), so
// a renamed kho ("Hàn Hải Nguyên" → "N1 - Hàn Hải Nguyên") still resolves.

export type LedgerHistory = { at: string; action: string; changes: unknown[] };
export type LedgerLot = {
  id: string;
  quantity: number;
  unitCost: number;
  purchasedOn: string;
  receiptCode?: string;
  internalReturn?: boolean;
  availableFrom?: string;
  storeId?: string;
  transferredFromId?: string;
  transferredOn?: string;
  pieceAmount?: number;
  history?: LedgerHistory[];
};
export type LedgerSession = { sourceReceiptId: string; activatedAt: string; costRecognitionMonth?: string };

type Change = { field?: unknown; from?: unknown; to?: unknown };
type Move = { date: string; at: string; fromStoreId?: string };
type Split = { date: string; at: string; toStoreId?: string };
type Merge = { date: string; at: string; fromStoreId?: string; quantity: number };

export type StoreFlow = { lotId: string; date: string; fromStoreId: string; toStoreId: string; value: number };

function changesOf(entry: LedgerHistory): Change[] {
  return Array.isArray(entry.changes) ? entry.changes as Change[] : [];
}
function textOf(value: unknown) { return String(value ?? ""); }
function firstSegment(value: unknown) { return textOf(value).split(" · ")[0].trim(); }
function businessDate(value: unknown) {
  const matches = [...textOf(value).matchAll(/(\d{2})\/(\d{2})\/(\d{4})/g)];
  const last = matches[matches.length - 1];
  return last ? `${last[3]}-${last[2]}-${last[1]}` : undefined;
}
function amountOf(value: unknown) {
  const parsed = Number(String(value ?? "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}
function isMergeText(value: unknown) {
  return /^\s*gop lai\b/.test(foldSignal(value));
}

export function storeResolver(stores: CloudStore[]) {
  const named = stores.map((store) => ({ id: store.id, key: foldSignal(store.name) })).filter((store) => store.key);
  const cache = new Map<string, string | undefined>();
  return (text: unknown) => {
    const key = foldSignal(firstSegment(text)).replace(/^gop lai\s+/, "");
    if (!key) return undefined;
    if (cache.has(key)) return cache.get(key);
    const exact = named.find((store) => store.key === key);
    const contained = exact ? undefined : named
      .filter((store) => store.key.includes(key) || key.includes(store.key))
      .sort((left, right) => right.key.length - left.key.length)[0];
    const id = (exact || contained)?.id;
    cache.set(key, id);
    return id;
  };
}

export type StoreLedger = ReturnType<typeof buildStoreLedger>;

export function buildStoreLedger(lots: LedgerLot[], sessions: LedgerSession[], stores: CloudStore[], defaultStoreId: string) {
  const resolve = storeResolver(stores);
  const lotsById = new Map(lots.map((lot) => [lot.id, lot]));
  const lotsByCode = new Map(lots.filter((lot) => lot.receiptCode).map((lot) => [lot.receiptCode!, lot]));
  const storeOf = (lot: LedgerLot) => lot.storeId || defaultStoreId;
  const recognizedOn = (session: LedgerSession) => session.costRecognitionMonth ? `${session.costRecognitionMonth}-01` : session.activatedAt.slice(0, 10);
  const sessionsByLot = new Map<string, string[]>();
  for (const session of sessions) sessionsByLot.set(session.sourceReceiptId, [...(sessionsByLot.get(session.sourceReceiptId) || []), recognizedOn(session)]);

  const moves = new Map<string, Move[]>();
  const splits = new Map<string, Split[]>();
  const merges = new Map<string, Merge[]>();
  /// A lot born after its purchase: before `date` its value sat in `parentId`
  /// (or, when that parent no longer exists, in `fromStoreId`).
  const creation = new Map<string, { date: string; parentId?: string; fromStoreId?: string }>();
  const transferDates = new Set<string>();

  for (const lot of lots) {
    for (const entry of lot.history || []) {
      const changes = changesOf(entry);
      const field = (name: string) => changes.find((change) => change.field === name);
      const transfer = field("transfer");
      const store = field("store");
      const piece = field("piece");
      if (entry.action === "created") {
        if (transfer) {
          const date = businessDate(transfer.to);
          if (date) { creation.set(lot.id, { date, parentId: lot.transferredFromId, fromStoreId: resolve(transfer.from) }); transferDates.add(date); }
        } else if (piece && lot.receiptCode?.includes("-LE-")) {
          const date = businessDate(piece.to);
          const source = lotsByCode.get(lot.receiptCode.split("-LE-")[0]);
          if (date && source) creation.set(lot.id, { date, parentId: source.id });
        }
        continue;
      }
      if (store) {
        const date = businessDate(store.to);
        if (date) { moves.set(lot.id, [...(moves.get(lot.id) || []), { date, at: entry.at, fromStoreId: resolve(store.from) }]); transferDates.add(date); }
        continue;
      }
      if (!transfer) continue;
      const date = businessDate(transfer.to);
      if (!date) continue;
      transferDates.add(date);
      if (isMergeText(transfer.to)) {
        const quantity = field("quantity");
        merges.set(lot.id, [...(merges.get(lot.id) || []), { date, at: entry.at, fromStoreId: resolve(transfer.from), quantity: quantity ? amountOf(quantity.to) - amountOf(quantity.from) : 0 }]);
      } else if (field("quantity")) {
        splits.set(lot.id, [...(splits.get(lot.id) || []), { date, at: entry.at, toStoreId: resolve(transfer.to) }]);
      }
    }
  }
  for (const list of moves.values()) list.sort((left, right) => left.date.localeCompare(right.date) || left.at.localeCompare(right.at));

  // passed(d, t, true): d happened by the end of t; passed(d, t, false): before t began.
  const passed = (eventDate: string, refDate: string, inclusive: boolean) => inclusive ? eventDate <= refDate : eventDate < refDate;

  function locationAt(lot: LedgerLot, date: string, inclusive: boolean, depth = 0): string {
    const born = creation.get(lot.id);
    if (born && !passed(born.date, date, inclusive)) {
      const parent = born.parentId ? lotsById.get(born.parentId) : undefined;
      if (parent && depth < 30) return locationAt(parent, date, inclusive, depth + 1);
      return born.fromStoreId || storeOf(lot);
    }
    const pending = (moves.get(lot.id) || []).find((move) => !passed(move.date, date, inclusive));
    return pending?.fromStoreId || storeOf(lot);
  }

  function lotValueAt(lot: LedgerLot, date: string, inclusive: boolean) {
    const start = lot.availableFrom || lot.purchasedOn;
    if (!passed(start, date, inclusive)) return 0;
    const issued = (sessionsByLot.get(lot.id) || []).filter((day) => passed(day, date, inclusive)).length;
    return Math.max(0, lot.quantity - issued) * lot.unitCost;
  }

  /// A child merged back no longer exists and its units sit in the parent's
  /// quantity. Between its split and the merge they were elsewhere: these
  /// windows give that value back to the kho that held it.
  const mergeWindows: Array<{ parent: LedgerLot; storeId: string; from: string; until: string; value: number }> = [];
  for (const [parentId, parentMerges] of merges) {
    const parent = lotsById.get(parentId);
    if (!parent) continue;
    const parentSplits = splits.get(parentId) || [];
    const used = new Set<Split>();
    for (const merge of [...parentMerges].sort((left, right) => left.at.localeCompare(right.at))) {
      if (!merge.fromStoreId || merge.quantity <= 0) continue;
      const split = parentSplits.filter((entry) => !used.has(entry) && entry.toStoreId === merge.fromStoreId && entry.at <= merge.at).at(-1);
      if (!split) continue;
      used.add(split);
      if (split.date === merge.date) continue;
      mergeWindows.push({ parent, storeId: merge.fromStoreId, from: split.date, until: merge.date, value: merge.quantity * parent.unitCost });
    }
  }

  /// Stock value per store at `date`, with the per-lot amounts for the report.
  function stockAt(date: string, inclusive: boolean) {
    const byStore = new Map<string, number>();
    const entries: Array<{ lot: LedgerLot; storeId: string; amount: number }> = [];
    for (const lot of lots) {
      const amount = lotValueAt(lot, date, inclusive);
      if (amount <= 0) continue;
      const storeId = locationAt(lot, date, inclusive);
      byStore.set(storeId, (byStore.get(storeId) || 0) + amount);
      entries.push({ lot, storeId, amount });
    }
    for (const window of mergeWindows) {
      if (!passed(window.from, date, inclusive) || passed(window.until, date, inclusive)) continue;
      const parentStore = locationAt(window.parent, date, inclusive);
      if (parentStore === window.storeId) continue;
      byStore.set(parentStore, (byStore.get(parentStore) || 0) - window.value);
      byStore.set(window.storeId, (byStore.get(window.storeId) || 0) + window.value);
    }
    return { byStore, entries };
  }

  /// Every change of location inside [start, end], valued at the lot's value as
  /// the day began (that day's issues then count at the receiving kho).
  function flowsBetween(start: string, end: string): StoreFlow[] {
    const dates = [...transferDates].filter((date) => date >= start && date <= end).sort();
    const flows: StoreFlow[] = [];
    for (const date of dates) {
      for (const lot of lots) {
        const before = locationAt(lot, date, false);
        const after = locationAt(lot, date, true);
        if (before === after) continue;
        const value = lotValueAt(lot, date, false);
        if (value > 0) flows.push({ lotId: lot.id, date, fromStoreId: before, toStoreId: after, value });
      }
      for (const window of mergeWindows) {
        if (window.from === date) {
          const parentStore = locationAt(window.parent, date, true);
          if (parentStore !== window.storeId) flows.push({ lotId: window.parent.id, date, fromStoreId: parentStore, toStoreId: window.storeId, value: window.value });
        }
        if (window.until === date) {
          const parentStore = locationAt(window.parent, date, true);
          if (parentStore !== window.storeId) flows.push({ lotId: window.parent.id, date, fromStoreId: window.storeId, toStoreId: parentStore, value: window.value });
        }
      }
    }
    return flows;
  }

  /// The kho that held the goods on the day they were bought — where the
  /// purchase (and its cash) belongs.
  function purchaseStoreOf(lot: LedgerLot) {
    return locationAt(lot, lot.purchasedOn, true);
  }

  return { locationAt, lotValueAt, stockAt, flowsBetween, purchaseStoreOf, transferDates: [...transferDates].sort() };
}
