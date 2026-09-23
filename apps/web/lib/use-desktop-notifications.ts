'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import type { ManagerEventDto } from './agent-manager-client.ts';
import {
  desktopNotificationsEnabled,
  takeFinishedRdRun,
  type FinishedRunStatus,
} from './desktop-notifications.ts';
import type { TranslationKey } from '@/locales/zh-CN';

export type DesktopNotificationAvailability = 'checking' | 'ready' | 'prompt' | 'blocked' | 'insecure' | 'unsupported';

const storageKey = 'code-factory.desktop-notifications';

const outcomeText: Record<FinishedRunStatus, TranslationKey> = {
  succeeded: 'RD task succeeded. Click to open the Requirement.',
  failed: 'RD task failed. Click to open the Requirement.',
  timed_out: 'RD task timed out. Click to open the Requirement.',
  cancelled: 'RD task was cancelled. Click to open the Requirement.',
};

function browserAvailability(): DesktopNotificationAvailability {
  if (!window.isSecureContext) return 'insecure';
  if (!('Notification' in window)) return 'unsupported';
  if (Notification.permission === 'denied') return 'blocked';
  return Notification.permission === 'granted' ? 'ready' : 'prompt';
}

function readOptIn(): boolean {
  try {
    return desktopNotificationsEnabled(window.localStorage.getItem(storageKey));
  } catch {
    return true;
  }
}

function saveOptIn(enabled: boolean): void {
  try {
    window.localStorage.setItem(storageKey, enabled ? 'on' : 'off');
  } catch {
    // This tab can still show notifications until it closes when storage is unavailable.
  }
}

export function useDesktopNotifications(
  t: (key: TranslationKey) => string,
  openRequirement: (requirementId: string) => void,
) {
  const [availability, setAvailability] = useState<DesktopNotificationAvailability>('checking');
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const enabledRef = useRef(true);
  const seenRunIdsRef = useRef(new Set<string>());
  const translateRef = useRef(t);
  const openRequirementRef = useRef(openRequirement);

  useEffect(() => {
    translateRef.current = t;
    openRequirementRef.current = openRequirement;
  }, [openRequirement, t]);

  useEffect(() => {
    const sync = () => {
      const nextAvailability = browserAvailability();
      setAvailability(nextAvailability);
      const optedIn = readOptIn();
      enabledRef.current = optedIn;
      setEnabled(optedIn);
    };
    sync();
    window.addEventListener('focus', sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener('focus', sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  const requestPermission = useCallback(async () => {
    if (browserAvailability() !== 'prompt') return;
    setBusy(true);
    try {
      // Request permission directly from this click handler to retain the user gesture.
      await Notification.requestPermission();
      setAvailability(browserAvailability());
    } catch {
      setAvailability(browserAvailability());
    } finally {
      setBusy(false);
    }
  }, []);

  const setPreference = useCallback(async (nextEnabled: boolean) => {
    enabledRef.current = nextEnabled;
    setEnabled(nextEnabled);
    saveOptIn(nextEnabled);
    if (nextEnabled && browserAvailability() === 'prompt') await requestPermission();
  }, [requestPermission]);

  const toggle = useCallback(async () => {
    if (enabledRef.current && browserAvailability() === 'prompt') {
      await requestPermission();
      return;
    }
    await setPreference(!enabledRef.current);
  }, [requestPermission, setPreference]);

  const notifyForEvent = useCallback((event: ManagerEventDto) => {
    const finished = takeFinishedRdRun(event, seenRunIdsRef.current);
    if (!finished || !enabledRef.current || browserAvailability() !== 'ready'
      || Notification.permission !== 'granted') return;

    try {
      const notification = new Notification(`Code Factory · ${finished.requirementTitle}`, {
        body: translateRef.current(outcomeText[finished.status]),
        icon: '/favicon.svg',
        tag: `code-factory-${finished.runId}`,
      });
      notification.onclick = () => {
        window.focus();
        openRequirementRef.current(finished.requirementId);
        notification.close();
      };
    } catch {
      // Permission can change between the check and notification construction.
    }
  }, []);

  return { availability, enabled, busy, requestPermission, setPreference, toggle, notifyForEvent };
}
