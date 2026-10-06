'use client';

import { useEffect, useState, type SyntheticEvent } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { useI18n } from '@/lib/i18n';
import type { AgentManagerClient, NativeApiProfileDto } from '@/lib/agent-manager-client';

export function NativeAuthSettings({ client }: { client: AgentManagerClient }) {
  const { t } = useI18n();
  const [items, setItems] = useState<NativeApiProfileDto[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [format, setFormat] = useState<'openai' | 'anthropic'>('openai');
  const [baseUrl, setBaseUrl] = useState('https://api.openai.com/v1');
  const [apiKey, setApiKey] = useState('');
  const [modelName, setModelName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void client.getNativeAuth().then((result) => { if (active) setItems(result.items); })
      .catch((caught: unknown) => { if (active) setError(caught instanceof Error ? caught.message : t('Failed to load Native Agent authentication')); });
    return () => { active = false; };
  }, [client, t]);

  async function save(event: SyntheticEvent<HTMLFormElement, SubmitEvent>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await client.saveNativeApiProfile({ ...(editingId ? { id: editingId } : {}), format, baseUrl,
        ...(apiKey.trim() ? { apiKey } : {}), modelName });
      setItems((await client.getNativeAuth()).items);
      setApiKey('');
      setModelName('');
      setAdding(false);
      setEditingId(null);
    } catch (caught) { setError(caught instanceof Error ? caught.message : t('Failed to save API profile')); }
    finally { setBusy(false); }
  }

  async function remove(id: string) {
    setBusy(true);
    setError(null);
    try {
      await client.removeNativeApiProfile(id);
      setItems((current) => current?.filter((item) => item.id !== id) ?? null);
    } catch (caught) { setError(caught instanceof Error ? caught.message : t('Failed to remove API profile')); }
    finally { setBusy(false); }
  }

  return (
    <div className="rounded-lg border border-border p-3 sm:col-span-2">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-xs font-medium">{t('Native Agent API profiles')}</p>
          <p className="mt-1 text-[10px] text-muted-foreground">{t('Saved API keys are not shown again. Changes apply to later Native Agent runs.')}</p>
        </div>
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => {
          setEditingId(null);
          setFormat('openai');
          setBaseUrl('https://api.openai.com/v1');
          setApiKey('');
          setModelName('');
          setAdding(true);
        }}>{t('Add item')}</Button>
      </div>
      <div className="mt-3 grid gap-2">
        {items?.map((item) => (
          <div key={item.id} className="flex items-start justify-between gap-3 rounded-md border border-border p-3">
            <div className="min-w-0 text-xs">
              <p className="font-medium">{item.modelName} · {t(item.format === 'openai' ? 'OpenAI format' : 'Anthropic format')}</p>
              <p className="mt-1 break-all text-muted-foreground">{item.baseUrl}</p>
            </div>
            <div className="flex shrink-0 gap-1">
              <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => {
                setEditingId(item.id);
                setFormat(item.format);
                setBaseUrl(item.baseUrl);
                setApiKey('');
                setModelName(item.modelName);
                setAdding(true);
              }}>{t('Edit')}</Button>
              <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void remove(item.id)}>{t('Remove')}</Button>
            </div>
          </div>
        ))}
        {items?.length === 0 ? <p className="text-xs text-muted-foreground">{t('No API profiles saved yet.')}</p> : null}
      </div>
      {adding ? (
        <form className="mt-3 grid gap-2 rounded-md border border-border p-3" onSubmit={save}>
          <label className="text-xs font-medium" htmlFor="native-api-format">{t('API format')}</label>
          <NativeSelect id="native-api-format" className="w-full" value={format}
            disabled={editingId?.startsWith('legacy-') ?? false} onChange={(event) => {
            const next = event.target.value as 'openai' | 'anthropic';
            setFormat(next);
            setBaseUrl(next === 'openai' ? 'https://api.openai.com/v1' : 'https://api.anthropic.com');
          }}>
            <NativeSelectOption value="openai">{t('OpenAI format')}</NativeSelectOption>
            <NativeSelectOption value="anthropic">{t('Anthropic format')}</NativeSelectOption>
          </NativeSelect>
          <label className="text-xs font-medium" htmlFor="native-api-base-url">{t('Base URL')}</label>
          <Input id="native-api-base-url" type="url" required value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} />
          <label className="text-xs font-medium" htmlFor="native-api-key">{t('API key')}</label>
          <Input id="native-api-key" type="password" autoComplete="off" required={!editingId}
            placeholder={editingId ? t('Leave blank to keep saved key') : undefined}
            value={apiKey} onChange={(event) => setApiKey(event.target.value)} />
          <label className="text-xs font-medium" htmlFor="native-model-name">{t('Model name')}</label>
          <Input id="native-model-name" required value={modelName} onChange={(event) => setModelName(event.target.value)} />
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" size="sm" variant="outline" onClick={() => { setAdding(false); setEditingId(null); }}>{t('Cancel')}</Button>
            <Button type="submit" size="sm" disabled={busy || (!editingId && !apiKey.trim()) || !modelName.trim() || !baseUrl.trim()}>{t('Save')}</Button>
          </div>
        </form>
      ) : null}
      {error ? <p className="mt-2 text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
