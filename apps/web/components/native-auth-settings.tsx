'use client';

import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { useI18n } from '@/lib/i18n';
import type { AgentManagerClient, NativeAuthProviderStatus, NativeLoginDto } from '@/lib/agent-manager-client';

const providers = [
  { id: 'openai', name: 'OpenAI', apiKey: true, subscription: true },
  { id: 'anthropic', name: 'Anthropic', apiKey: true, subscription: false },
  { id: 'openai-codex', name: 'Codex subscription', apiKey: false, subscription: true },
] as const;

export function NativeAuthSettings({ client }: { client: AgentManagerClient }) {
  const { t } = useI18n();
  const [statuses, setStatuses] = useState<NativeAuthProviderStatus[] | null>(null);
  const [keys, setKeys] = useState({ openai: '', anthropic: '' });
  const [login, setLogin] = useState<NativeLoginDto | null>(null);
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void client.getNativeAuth().then((result) => {
      if (active) { setStatuses(result.providers); setLogin(result.login); }
    })
      .catch((caught: unknown) => { if (active) setError(caught instanceof Error ? caught.message : t('Failed to load Native Agent authentication')); });
    return () => { active = false; };
  }, [client, t]);

  useEffect(() => {
    if (!login || login.state === 'succeeded' || login.state === 'failed' || login.state === 'cancelled') return;
    let active = true;
    const poll = async () => {
      try {
        const next = await client.getNativeLogin(login.id);
        if (!active) return;
        setLogin(next);
        if (next.state === 'succeeded') {
          const result = await client.getNativeAuth();
          if (active) setStatuses(result.providers);
        }
      } catch (caught) {
        if (active) setError(caught instanceof Error ? caught.message : t('Failed to check login status'));
      }
    };
    const interval = window.setInterval(() => void poll(), 1500);
    return () => { active = false; window.clearInterval(interval); };
  }, [client, login]);

  async function saveKey(provider: 'openai' | 'anthropic') {
    setBusy(provider);
    setError(null);
    try {
      setStatuses(await client.setNativeApiKey(provider, keys[provider]));
      setKeys((current) => ({ ...current, [provider]: '' }));
    } catch (caught) { setError(caught instanceof Error ? caught.message : t('Failed to save API key')); }
    finally { setBusy(null); }
  }

  async function remove(provider: 'openai' | 'anthropic' | 'openai-codex') {
    setBusy(provider);
    setError(null);
    try { setStatuses(await client.removeNativeAuth(provider)); }
    catch (caught) { setError(caught instanceof Error ? caught.message : t('Failed to remove credential')); }
    finally { setBusy(null); }
  }

  async function startLogin(provider: 'openai' | 'openai-codex') {
    setBusy(provider);
    setError(null);
    setAnswer('');
    try { setLogin(await client.startNativeLogin(provider)); }
    catch (caught) { setError(caught instanceof Error ? caught.message : t('Failed to start login')); }
    finally { setBusy(null); }
  }

  async function submitAnswer() {
    if (!login) return;
    setBusy('login');
    setError(null);
    try { setLogin(await client.answerNativeLogin(login.id, answer)); setAnswer(''); }
    catch (caught) { setError(caught instanceof Error ? caught.message : t('Failed to submit login response')); }
    finally { setBusy(null); }
  }

  async function cancelLogin() {
    if (!login) return;
    setBusy('login');
    try { setLogin(await client.cancelNativeLogin(login.id)); }
    catch (caught) { setError(caught instanceof Error ? caught.message : t('Failed to cancel login')); }
    finally { setBusy(null); }
  }

  const loginActive = login?.state === 'pending' || login?.state === 'prompt';
  const sourceLabel = (source: NativeAuthProviderStatus['source']) => source === 'subscription'
    ? t('Subscription credential saved') : source === 'stored_api_key' ? t('API key configured')
      : source === 'environment' ? t('API key from environment') : t('Not configured');

  return (
    <div className="rounded-lg border border-border p-3 sm:col-span-2">
      <p className="text-xs font-medium">{t('Native Agent authentication')}</p>
      <p className="mt-1 text-[10px] text-muted-foreground">{t('Credentials apply immediately to subsequent Native Agent runs. Saved secrets are not shown again.')}</p>
      <div className="mt-3 grid gap-3">
        {providers.map((provider) => {
          const source = statuses?.find((item) => item.provider === provider.id)?.source ?? null;
          return (
            <div key={provider.id} className="rounded-md border border-border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-medium">{t(provider.name)}</span>
                <span className="text-[10px] text-muted-foreground">{statuses ? sourceLabel(source) : t('Loading…')}</span>
              </div>
              {provider.apiKey ? (
                <div className="mt-2 flex flex-wrap gap-2">
                  <Input className="min-w-40 flex-1" type="password" autoComplete="off"
                    aria-label={`${provider.name} ${t('API key')}`} placeholder={t('Enter API key')}
                    value={keys[provider.id]} onChange={(event) => setKeys((current) => ({ ...current, [provider.id]: event.target.value }))}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        if (keys[provider.id].trim() && busy === null) void saveKey(provider.id);
                      }
                    }} />
                  <Button type="button" size="sm" variant="outline" disabled={!keys[provider.id].trim() || busy !== null}
                    onClick={() => void saveKey(provider.id)}>{t('Save key')}</Button>
                </div>
              ) : null}
              <div className="mt-2 flex flex-wrap gap-2">
                {provider.subscription ? (
                  <Button type="button" size="sm" variant="outline" disabled={busy !== null || loginActive}
                    onClick={() => void startLogin(provider.id)}>{t('Connect subscription')}</Button>
                ) : null}
                {source === 'stored_api_key' || source === 'subscription' ? (
                  <Button type="button" size="sm" variant="outline" disabled={busy !== null}
                    onClick={() => void remove(provider.id)}>{t('Remove saved credential')}</Button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
      {login ? (
        <div className="mt-3 rounded-md border border-border p-3 text-xs">
          <p className="font-medium">{t('Subscription login')}: {t(login.provider === 'openai' ? 'OpenAI' : 'Codex subscription')} · {t(login.state === 'succeeded' ? 'Connected' : login.state === 'failed' ? 'Failed' : login.state === 'cancelled' ? 'Cancelled' : 'In progress')}</p>
          {login.authorizationUrl ? <a className="mt-2 block break-all text-primary underline" href={login.authorizationUrl} target="_blank" rel="noreferrer">{t('Open authorization page')}</a> : null}
          {login.verificationUri ? <a className="mt-2 block break-all text-primary underline" href={login.verificationUri} target="_blank" rel="noreferrer">{t('Open device verification page')}</a> : null}
          {login.userCode ? <p className="mt-2 font-mono">{t('Device code')}: {login.userCode}</p> : null}
          {login.message ? <p className="mt-2 text-muted-foreground">{login.message}</p> : null}
          {login.prompt ? (
            <div className="mt-3">
              <p className="mb-2 text-muted-foreground">{login.prompt.message}</p>
              <div className="flex flex-wrap gap-2">
              {login.prompt.type === 'select' ? (
                <NativeSelect aria-label={t('Login response')} value={answer} onChange={(event) => setAnswer(event.target.value)}>
                  <NativeSelectOption value="">{t('Select an option')}</NativeSelectOption>
                  {login.prompt.options.map((option) => <NativeSelectOption key={option.id} value={option.id}>{option.label}</NativeSelectOption>)}
                </NativeSelect>
              ) : <Input className="min-w-40 flex-1" aria-label={t('Login response')}
                type={login.prompt.type === 'secret' ? 'password' : 'text'} autoComplete="off"
                placeholder={login.prompt.placeholder ?? login.prompt.message} value={answer}
                onChange={(event) => setAnswer(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    if (answer.trim() && busy === null) void submitAnswer();
                  }
                }} />}
              <Button type="button" size="sm" disabled={!answer.trim() || busy !== null}
                onClick={() => void submitAnswer()}>{t('Continue login')}</Button>
              </div>
            </div>
          ) : null}
          {loginActive ? <Button className="mt-2" type="button" size="sm" variant="ghost" disabled={busy !== null}
            onClick={() => void cancelLogin()}>{t('Cancel login')}</Button> : null}
        </div>
      ) : null}
      {error ? <p className="mt-2 text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
