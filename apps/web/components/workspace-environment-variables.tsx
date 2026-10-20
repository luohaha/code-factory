'use client';

import { useId, useRef, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { useI18n } from '@/lib/i18n';

export function workspaceEnvironmentVariables(fields: FormData): Record<string, string | null> {
  const field = fields.get('environmentVariables');
  if (field !== null && typeof field !== 'string') throw new Error('Invalid environment variables');
  const value: unknown = JSON.parse(field ?? '{}');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid environment variables');
  const entries: Array<[string, string | null]> = [];
  for (const [name, content] of Object.entries(value)) {
    if (typeof content !== 'string' && content !== null) throw new Error('Invalid environment variables');
    entries.push([name, content]);
  }
  return Object.fromEntries(entries);
}

export function WorkspaceEnvironmentVariables({ names = [] }: { names?: string[] }) {
  const { t } = useI18n();
  const id = useId();
  const nextId = useRef(names.length);
  const [rows, setRows] = useState(() => names.map((name, index) => ({ id: index, name, value: '', saved: true })));
  const updates = new Map<string, string | null>();
  for (const name of names) if (!rows.some((row) => row.name === name)) updates.set(name, null);
  for (const row of rows) {
    if (row.name && (!row.saved || row.value !== '')) updates.set(row.name, row.value);
  }
  return <Field>
    <FieldLabel>{t('Environment variables')}</FieldLabel>
    <p className="text-xs text-muted-foreground">{t('Values stay hidden after saving and apply to later Native Agent commands.')}</p>
    <input type="hidden" name="environmentVariables" value={JSON.stringify(Object.fromEntries(updates))} />
    <div className="grid gap-2">
      {rows.map((row, index) => {
        const duplicate = rows.some((other) => other.id !== row.id && other.name === row.name);
        return <div key={row.id} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-start gap-2">
          <Input id={`${id}-name-${row.id}`} aria-label={`${t('Variable name')} ${index + 1}`}
            required maxLength={128} pattern="[A-Za-z_][A-Za-z0-9_]*" placeholder="GH_TOKEN"
            value={row.name} readOnly={row.saved} autoComplete="off" spellCheck={false}
            ref={(input) => { input?.setCustomValidity(duplicate ? t('Environment variable names must be unique.') : ''); }}
            onChange={(event) => setRows((current) => current.map((item) => item.id === row.id ? { ...item, name: event.target.value } : item))} />
          <Input aria-label={`${t('Variable value')} ${index + 1}`} type="password" autoComplete="new-password"
            placeholder={row.saved ? t('Leave blank to keep saved value') : t('Variable value')}
            value={row.value}
            onChange={(event) => setRows((current) => current.map((item) => item.id === row.id ? { ...item, value: event.target.value } : item))} />
          <Button type="button" variant="ghost" size="icon" aria-label={`${t('Remove variable')} ${row.name || index + 1}`}
            onClick={() => setRows((current) => current.filter((item) => item.id !== row.id))}><Trash2 /></Button>
        </div>;
      })}
    </div>
    <Button type="button" variant="outline" size="sm" className="self-start" disabled={rows.length >= 100}
      onClick={() => {
        const row = { id: nextId.current++, name: '', value: '', saved: false };
        setRows((current) => [...current, row]);
      }}>
      <Plus />{t('Add variable')}
    </Button>
  </Field>;
}
