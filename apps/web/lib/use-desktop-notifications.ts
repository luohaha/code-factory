'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import type { ManagerEventDto } from './agent-manager-client.ts';
import { takeFinishedRdRun, type FinishedRunStatus } from './desktop-notifications.ts';
import type { TranslationKey } from '@/locales/zh-CN';

type Availability = 'checking' | 'ready' | 'blocked' | 'insecure' | 'unsupported';

const storageKey = 'code-factory.desktop-notifications';

const outcomeText: Record<FinishedRunStatus, TranslationKey> = {
  succeeded: 'RD task succeeded. Click to open the Requirement.',
  failed: 'RD task failed. Click to open the Requirement.',
  timed_out: 'RD task timed out. Click to open the Requirement.',
  cancelled: 'RD task was cancelled. Click to open the Requirement.',
};

function browserAvailability(): Availability {
  if (!window.isSecureContext) return 'insecure';
  if (!('Notification' in window)) return 'unsupported';
  return Notification.permission === 'denied' ? 'blocked' : 'ready';
}

function readOptIn(): boolean | null {
  try {
    return window.localStorage.getItem(storageKey) === 'on';
  } catch {
    return null;
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
  const [availability, setAvailability] = useState<Availability>('checking');
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const enabledRef = useRef(false);
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
      if (nextAvailability !== 'ready' || Notification.permission !== 'granted') {
        enabledRef.current = false;
        setEnabled(false);
      } else {
        const optedIn = readOptIn();
        if (optedIn !== null) {
          enabledRef.current = optedIn;
          setEnabled(optedIn);
        }
      }
    };
    sync();
    window.addEventListener('focus', sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener('focus', sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  const toggle = useCallback(async () => {
    if (browserAvailability() !== 'ready') return;
    if (enabledRef.current) {
      enabledRef.current = false;
      setEnabled(false);
      saveOptIn(false);
      return;
    }

    setBusy(true);
    try {
      // Request permission directly from this click handler to retain the user gesture.
      const permission = Notification.permission === 'granted'
        ? 'granted'
        : await Notification.requestPermission();
      setAvailability(permission === 'denied' ? 'blocked' : 'ready');
      if (permission === 'granted') {
        enabledRef.current = true;
        setEnabled(true);
        saveOptIn(true);
      }
    } catch {
      setAvailability(browserAvailability());
    } finally {
      setBusy(false);
    }
  }, []);

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

  return { availability, enabled, busy, toggle, notifyForEvent };
}
