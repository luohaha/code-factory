'use client';

import { useCallback, useEffect, useSyncExternalStore } from 'react';

import { normalizeManagerUrl } from './agent-manager-url.ts';

export interface DraftAttachment {
  id: string;
  file: File;
}

interface RequirementDraft {
  revision: string | null;
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
  saving: Promise<void> | null;
  persisted: RequirementDraft;
}

interface StoredDraft {
  revision?: string | null;
  message: string;
  attachmentIds: string[];
}

const emptyDraft: RequirementDraft = { revision: null, message: '', attachments: [] };
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
      draft = { revision: stored.revision ?? null, message: stored.message, attachments: [] };
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

async function writeDraft(key: string, draft: RequirementDraft, expected?: RequirementDraft): Promise<void> {
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
        // Compare and delete in the same transaction, including legacy drafts without a revision.
        if (expected && (!previous
          || (previous.revision ?? null) !== expected.revision
          || previous.message !== expected.message
          || previous.attachmentIds.length !== expected.attachments.length
          || previous.attachmentIds.some((id, index) => id !== expected.attachments[index]?.id))) return;
        if (draft.message || draft.attachments.length > 0) {
          drafts.put({ revision: draft.revision, message: draft.message, attachmentIds: draft.attachments.map(({ id }) => id) } satisfies StoredDraft, key);
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
    entry = { snapshot: initialSnapshot, listeners: new Set(), loading: null, saving: null, persisted: emptyDraft };
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

function saveDraft(key: string, entry: DraftEntry): Promise<void> {
  entry.saving ??= persistDraft(key, entry).finally(() => { entry.saving = null; });
  return entry.saving;
}

async function persistDraft(key: string, entry: DraftEntry) {
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
  }
}

async function clearSentDraft(key: string, entry: DraftEntry, sent: RequirementDraft) {
  await entry.saving;
  if (entry.snapshot.draft !== sent) return;
  try {
    await writeDraft(key, emptyDraft, sent);
  } catch {
    publish(entry, { ...entry.snapshot, storageUnavailable: true });
  }
  // Clear this tab's submitted text without scheduling an unconditional write over another tab.
  if (entry.snapshot.draft === sent) {
    entry.persisted = emptyDraft;
    publish(entry, { ...entry.snapshot, draft: emptyDraft });
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

  function updateDraft(draft: Omit<RequirementDraft, 'revision'>) {
    publish(entry, { ...entry.snapshot, draft: { ...draft, revision: crypto.randomUUID() } });
    void saveDraft(key, entry);
  }

  return { ...snapshot, updateDraft, flushDraft: () => saveDraft(key, entry), clearSentDraft: (sent: RequirementDraft) => clearSentDraft(key, entry, sent) };
}
