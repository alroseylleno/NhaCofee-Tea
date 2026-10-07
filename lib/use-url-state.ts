"use client";

import { Dispatch, SetStateAction, useEffect, useState } from "react";

/// Navigation state mirrored into one URL query parameter, so F5 reopens the
/// same workspace/tab instead of falling back to the Kho NVL home. Read after
/// mount (the page is prerendered, so reading during render would mismatch
/// hydration) and written with replaceState — switching tabs must not stack
/// browser history entries.
export function useUrlState<T extends string>(param: string, fallback: T, allowed: readonly T[]): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(fallback);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    const stored = new URLSearchParams(window.location.search).get(param);
    if (stored && (allowed as readonly string[]).includes(stored)) setValue(stored as T);
    setHydrated(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [param]);

  useEffect(() => {
    if (!hydrated) return;
    const url = new URL(window.location.href);
    if (value === fallback) url.searchParams.delete(param); else url.searchParams.set(param, value);
    if (url.href !== window.location.href) window.history.replaceState(window.history.state, "", url);
  }, [hydrated, value, fallback, param]);

  return [value, setValue];
}
