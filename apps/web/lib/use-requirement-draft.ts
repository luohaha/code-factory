'use client';

import { useCallback, useEffect, useSyncExternalStore } from 'react';

import { normalizeManagerUrl } from './agent-manager-url.ts';

export interface DraftAttachment {
  id: string;
  file: File;
}

interface RequirementDraft {
  message: string;
  attachments: DraftAttachment[];
}

interface DraftSnapshot {
  draft: RequirementDraft;
  ready: boolean;
  storageUnavailable: boolean;
}

interface DraftEntry {
  snapshot: DraftSnapshot;
  listeners: Set<() => void>;
  loading: Promise<void> | null;
  saving: boolean;
  persisted: RequirementDraft;
}

interface StoredDraft {
  message: string;
  attachmentIds: string[];
}

const emptyDraft: RequirementDraft = { message: '', attachments: [] };
const initialSnapshot: DraftSnapshot = { draft: emptyDraft, ready: false, storageUnavailable: false };
const entries = new Map<string, DraftEntry>();
let databasePromise: Promise<IDBDatabase> | null = null;

function database(): Promise<IDBDatabase> {
  databasePromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = window.indexedDB.open('code-factory.requirement-drafts', 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('drafts');
      request.result.createObjectStore('attachments');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }).catch((error: unknown) => {
    databasePromise = null;
    throw error;
  });
  return databasePromise;
}

async function readDraft(key: string): Promise<RequirementDraft> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['drafts', 'attachments'], 'readonly');
    let draft = emptyDraft;
    const request = transaction.objectStore('drafts').get(key);
    request.onsuccess = () => {
      const stored = request.result as StoredDraft | undefined;
      if (!stored) return;
      draft = { message: stored.message, attachments: [] };
      for (const id of stored.attachmentIds) {
        const attachment = transaction.objectStore('attachments').get([key, id]);
        attachment.onsuccess = () => {
          if (attachment.result) draft.attachments.push(attachment.result as DraftAttachment);
        };
      }
    };
    transaction.oncomplete = () => resolve(draft);
    transaction.onabort = () => reject(transaction.error);
  });
}

async function writeDraft(key: string, draft: RequirementDraft): Promise<void> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['drafts', 'attachments'], 'readwrite');
    const drafts = transaction.objectStore('drafts');
    const attachments = transaction.objectStore('attachments');
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
    function abort(error: unknown) {
      transaction.abort();
      reject(error);
    }
    const current = drafts.get(key);
    current.onsuccess = () => {
      try {
        const previous = current.result as StoredDraft | undefined;
        if (draft.message || draft.attachments.length > 0) {
          drafts.put({ message: draft.message, attachmentIds: draft.attachments.map(({ id }) => id) } satisfies StoredDraft, key);
        } else {
          drafts.delete(key);
        }
        // Other tabs can delete cached files. Check keys without cloning stored File bytes.
        for (const attachment of draft.attachments) {
          const exists = attachments.count([key, attachment.id]);
          exists.onsuccess = () => {
            if (exists.result > 0) return;
            try {
              attachments.put(attachment, [key, attachment.id]);
            } catch (error) {
              abort(error);
            }
          };
        }
        for (const id of previous?.attachmentIds ?? []) {
          if (!draft.attachments.some((attachment) => attachment.id === id)) {
            attachments.delete([key, id]);
          }
        }
      } catch (error) {
        abort(error);
      }
    };
  });
}

function entryFor(key: string): DraftEntry {
  let entry = entries.get(key);
  if (!entry) {
    entry = { snapshot: initialSnapshot, listeners: new Set(), loading: null, saving: false, persisted: emptyDraft };
    entries.set(key, entry);
  }
  return entry;
}

function publish(entry: DraftEntry, snapshot: DraftSnapshot) {
  entry.snapshot = snapshot;
  for (const listener of entry.listeners) listener();
}

function loadDraft(key: string, entry: DraftEntry) {
  if (entry.snapshot.ready || entry.loading) return;
  entry.loading = readDraft(key).then((draft) => {
    entry.persisted = draft;
    publish(entry, { draft, ready: true, storageUnavailable: false });
  }).catch(() => {
    publish(entry, { ...entry.snapshot, ready: true, storageUnavailable: true });
  });
}

async function saveDraft(key: string, entry: DraftEntry) {
  if (entry.saving) return;
  entry.saving = true;
  try {
    // Serialize writes and coalesce edits arriving during an in-flight transaction.
    while (entry.persisted !== entry.snapshot.draft) {
      const draft = entry.snapshot.draft;
      await writeDraft(key, draft);
      entry.persisted = draft;
    }
    if (entry.snapshot.storageUnavailable) publish(entry, { ...entry.snapshot, storageUnavailable: false });
  } catch {
    // The in-memory entry still survives closing and reopening the conversation.
    publish(entry, { ...entry.snapshot, storageUnavailable: true });
  } finally {
    entry.saving = false;
  }
}

export function useRequirementDraft(managerUrl: string, requirementId: string) {
  const key = JSON.stringify([normalizeManagerUrl(managerUrl), requirementId]);
  const entry = entryFor(key);
  const subscribe = useCallback((listener: () => void) => {
    entry.listeners.add(listener);
    return () => { entry.listeners.delete(listener); };
  }, [entry]);
  const snapshot = useSyncExternalStore(subscribe, () => entry.snapshot, () => initialSnapshot);
  useEffect(() => { loadDraft(key, entry); }, [entry, key]);

  function updateDraft(draft: RequirementDraft) {
    publish(entry, { ...entry.snapshot, draft });
    void saveDraft(key, entry);
  }

  function clearSentDraft(sent: RequirementDraft) {
    // A send can finish after closing/reopening the editor and writing a newer draft.
    if (entry.snapshot.draft === sent) updateDraft(emptyDraft);
  }

  return { ...snapshot, updateDraft, clearSentDraft };
}
