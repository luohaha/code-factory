'use client';

import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useSyncExternalStore } from 'react';

import { zhCN, type TranslationKey } from '@/locales/zh-CN';

export type Locale = 'en' | 'zh-CN';
type TranslationValues = Record<string, number | string>;

interface I18nValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: TranslationKey, values?: TranslationValues) => string;
}

const STORAGE_KEY = 'code-factory.locale';
const CHANGE_EVENT = 'code-factory.locale-change';
const I18nContext = createContext<I18nValue | null>(null);

function interpolate(template: string, values?: TranslationValues): string {
  if (!values) return template;
  return template.replace(/\{(\w+)\}/g, (match, key: string) => (
    Object.hasOwn(values, key) ? String(values[key]) : match
  ));
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const locale = useSyncExternalStore<Locale>(
    (onStoreChange) => {
      window.addEventListener('storage', onStoreChange);
      window.addEventListener(CHANGE_EVENT, onStoreChange);
      return () => {
        window.removeEventListener('storage', onStoreChange);
        window.removeEventListener(CHANGE_EVENT, onStoreChange);
      };
    },
    () => {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      return stored === 'en' || stored === 'zh-CN'
        ? stored
        : window.navigator.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
    },
    () => 'en' as const,
  );

  const setLocale = useCallback((next: Locale) => {
    window.localStorage.setItem(STORAGE_KEY, next);
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const t = useCallback((key: TranslationKey, values?: TranslationValues) => (
    interpolate(locale === 'zh-CN' ? zhCN[key] : key, values)
  ), [locale]);

  const value = useMemo(() => ({ locale, setLocale, t }), [locale, setLocale, t]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error('useI18n must be used inside I18nProvider');
  return value;
}
