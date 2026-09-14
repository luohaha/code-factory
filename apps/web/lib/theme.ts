'use client';

import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';

export type Theme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'code-factory.theme';
const THEME_CHANGE_EVENT = 'code-factory.theme-change';
let transientTheme: Theme | null = null;

function preferredTheme(): Theme {
  if (transientTheme) return transientTheme;

  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {
    // Fall back to the operating-system preference when storage is unavailable.
  }

  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function subscribe(onStoreChange: () => void): () => void {
  const colorScheme = window.matchMedia('(prefers-color-scheme: dark)');
  window.addEventListener('storage', onStoreChange);
  window.addEventListener(THEME_CHANGE_EVENT, onStoreChange);
  colorScheme.addEventListener('change', onStoreChange);

  return () => {
    window.removeEventListener('storage', onStoreChange);
    window.removeEventListener(THEME_CHANGE_EVENT, onStoreChange);
    colorScheme.removeEventListener('change', onStoreChange);
  };
}

function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle('dark', theme === 'dark');
  document.documentElement.style.colorScheme = theme;
}

export function useTheme() {
  const theme = useSyncExternalStore<Theme>(subscribe, preferredTheme, () => 'light');

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const setTheme = useCallback((next: Theme) => {
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
      transientTheme = null;
    } catch {
      transientTheme = next;
    }
    applyTheme(next);
    window.dispatchEvent(new Event(THEME_CHANGE_EVENT));
  }, []);

  return useMemo(() => ({ theme, setTheme }), [setTheme, theme]);
}
