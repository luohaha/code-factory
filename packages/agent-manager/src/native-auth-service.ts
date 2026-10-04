import { createHash, randomUUID } from 'node:crypto';

import type { AuthEvent, AuthInteraction, AuthPrompt } from '@earendil-works/pi-ai';

import { createNativeModels, NativeCredentialStore, nativeAuthDatabasePath } from './native-auth.js';
import { StoreConflictError, StoreNotFoundError } from './store.js';

export type NativeAuthProvider = 'openai' | 'anthropic' | 'openai-codex';
export type NativeOAuthProvider = 'openai' | 'openai-codex';

export interface NativeAuthProviderStatus {
  provider: NativeAuthProvider;
  source: 'stored_api_key' | 'subscription' | 'environment' | null;
}

export interface NativeLoginSnapshot {
  id: string;
  provider: NativeOAuthProvider;
  state: 'pending' | 'prompt' | 'succeeded' | 'failed' | 'cancelled';
  authorizationUrl: string | null;
  verificationUri: string | null;
  userCode: string | null;
  message: string | null;
  prompt: null | {
    type: AuthPrompt['type'];
    message: string;
    placeholder: string | null;
    options: readonly { id: string; label: string }[];
  };
}

interface PendingPrompt {
  resolve: (answer: string) => void;
  reject: (error: Error) => void;
  options: readonly string[] | null;
}

interface NativeLogin {
  snapshot: NativeLoginSnapshot;
  controller: AbortController;
  pendingPrompt: PendingPrompt | null;
  work: Promise<void>;
}

export type NativeOAuthLogin = (provider: NativeOAuthProvider, interaction: AuthInteraction,
  getDeviceId: () => string) => Promise<void>;

/** Web-facing auth operations share pi-ai's owner-only credential file with NativeAgentService. */
export class NativeAuthService {
  readonly #credentials: NativeCredentialStore;
  readonly #login: NativeOAuthLogin;
  readonly #deviceId: string;
  readonly #environment: Readonly<Record<string, string | undefined>>;
  #active: NativeLogin | null = null;

  constructor(nativeConversationDatabasePath: string, options: {
    login?: NativeOAuthLogin;
    environment?: Readonly<Record<string, string | undefined>>;
  } = {}) {
    this.#credentials = new NativeCredentialStore(nativeAuthDatabasePath(nativeConversationDatabasePath));
    const models = createNativeModels(this.#credentials);
    this.#login = options.login ?? (async (provider, interaction, getDeviceId) => {
      await models.login(provider, 'oauth', interaction, { getDeviceId });
    });
    const hex = createHash('sha256').update(nativeConversationDatabasePath).digest('hex');
    this.#deviceId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
    this.#environment = options.environment ?? process.env;
  }

  async status(): Promise<NativeAuthProviderStatus[]> {
    const providers: readonly NativeAuthProvider[] = ['openai', 'anthropic', 'openai-codex'];
    return Promise.all(providers.map(async (provider) => {
      const credential = await this.#credentials.read(provider);
      const environmentKey = provider === 'openai' ? this.#environment.OPENAI_API_KEY
        : provider === 'anthropic' ? this.#environment.ANTHROPIC_API_KEY : undefined;
      const source = credential?.type === 'oauth' ? 'subscription'
        : credential?.type === 'api_key' ? 'stored_api_key'
          : environmentKey ? 'environment' : null;
      return { provider, source };
    }));
  }

  activeLogin(): NativeLoginSnapshot | null {
    return this.#active ? this.#snapshot(this.#active) : null;
  }

  async setApiKey(provider: NativeAuthProvider, key: string): Promise<NativeAuthProviderStatus[]> {
    if (provider !== 'openai' && provider !== 'anthropic') throw new TypeError('API keys support openai and anthropic');
    if (!key.trim()) throw new TypeError('API key must be non-empty');
    await this.#cancelProviderLogin(provider);
    await this.#credentials.modify(provider, async () => ({ type: 'api_key', key: key.trim() }));
    return this.status();
  }

  async remove(provider: NativeAuthProvider): Promise<NativeAuthProviderStatus[]> {
    if (!['openai', 'anthropic', 'openai-codex'].includes(provider)) throw new TypeError('Unsupported Native Agent provider');
    await this.#cancelProviderLogin(provider);
    await this.#credentials.delete(provider);
    return this.status();
  }

  startLogin(provider: NativeOAuthProvider): NativeLoginSnapshot {
    if (provider !== 'openai' && provider !== 'openai-codex') throw new TypeError('Subscription login supports openai and openai-codex');
    if (this.#active && (this.#active.snapshot.state === 'pending' || this.#active.snapshot.state === 'prompt')) {
      throw new StoreConflictError('A Native Agent login is already in progress');
    }
    const snapshot: NativeLoginSnapshot = { id: randomUUID(), provider, state: 'pending',
      authorizationUrl: null, verificationUri: null, userCode: null, message: null, prompt: null };
    const login: NativeLogin = { snapshot, controller: new AbortController(), pendingPrompt: null,
      work: Promise.resolve() };
    this.#active = login;
    login.work = this.#runLogin(login);
    return this.#snapshot(login);
  }

  getLogin(id: string): NativeLoginSnapshot {
    if (this.#active?.snapshot.id !== id) throw new StoreNotFoundError(`Native Agent login ${id} not found`);
    return this.#snapshot(this.#active);
  }

  submitPrompt(id: string, answer: string): NativeLoginSnapshot {
    const login = this.#requireLogin(id);
    const pending = login.pendingPrompt;
    if (!pending || login.snapshot.state !== 'prompt') throw new StoreConflictError('Login is not waiting for input');
    if (!answer.trim() || pending.options && !pending.options.includes(answer)) throw new TypeError('Invalid login response');
    login.pendingPrompt = null;
    login.snapshot.prompt = null;
    login.snapshot.state = 'pending';
    pending.resolve(answer.trim());
    return this.#snapshot(login);
  }

  cancelLogin(id: string): NativeLoginSnapshot {
    const login = this.#requireLogin(id);
    if (login.snapshot.state === 'pending' || login.snapshot.state === 'prompt') {
      login.controller.abort(new Error('Login cancelled'));
      login.pendingPrompt?.reject(new Error('Login cancelled'));
      login.pendingPrompt = null;
      login.snapshot.prompt = null;
      login.snapshot.state = 'cancelled';
    }
    return this.#snapshot(login);
  }

  async close(): Promise<void> {
    if (this.#active && (this.#active.snapshot.state === 'pending' || this.#active.snapshot.state === 'prompt')) {
      this.cancelLogin(this.#active.snapshot.id);
    }
    await this.#active?.work;
    await this.#credentials.close();
  }

  #requireLogin(id: string): NativeLogin {
    if (this.#active?.snapshot.id !== id) throw new StoreNotFoundError(`Native Agent login ${id} not found`);
    return this.#active;
  }

  #snapshot(login: NativeLogin): NativeLoginSnapshot {
    return { ...login.snapshot, prompt: login.snapshot.prompt
      ? { ...login.snapshot.prompt, options: [...login.snapshot.prompt.options] } : null };
  }

  async #cancelProviderLogin(provider: NativeAuthProvider): Promise<void> {
    const login = this.#active;
    if (!login || login.snapshot.provider !== provider) return;
    if (login.snapshot.state === 'pending' || login.snapshot.state === 'prompt') {
      this.cancelLogin(login.snapshot.id);
      await login.work;
    }
  }

  async #runLogin(login: NativeLogin): Promise<void> {
    const interaction: AuthInteraction = {
      signal: login.controller.signal,
      notify: (event: AuthEvent) => {
        if (event.type === 'auth_url') login.snapshot.authorizationUrl = event.url;
        else if (event.type === 'device_code') {
          login.snapshot.verificationUri = event.verificationUri;
          login.snapshot.userCode = event.userCode;
        } else login.snapshot.message = event.message;
      },
      prompt: (prompt: AuthPrompt) => {
        if (prompt.type === 'select' && login.snapshot.provider === 'openai-codex'
          && prompt.options.some((option) => option.id === 'device_code')) {
          return Promise.resolve('device_code');
        }
        if (login.controller.signal.aborted) return Promise.reject(new Error('Login cancelled'));
        login.snapshot.state = 'prompt';
        login.snapshot.prompt = { type: prompt.type, message: prompt.message,
          placeholder: 'placeholder' in prompt ? prompt.placeholder ?? null : null,
          options: prompt.type === 'select' ? prompt.options.map(({ id, label }) => ({ id, label })) : [] };
        return new Promise<string>((resolve, reject) => {
          const onAbort = () => {
            if (login.pendingPrompt?.resolve === accept) {
              login.pendingPrompt = null;
              login.snapshot.prompt = null;
              login.snapshot.state = 'pending';
            }
            reject(new Error('Login cancelled'));
          };
          const accept = (answer: string) => {
            prompt.signal?.removeEventListener('abort', onAbort);
            resolve(answer);
          };
          login.pendingPrompt = { resolve: accept, reject,
            options: prompt.type === 'select' ? prompt.options.map((option) => option.id) : null };
          prompt.signal?.addEventListener('abort', onAbort, { once: true });
          if (prompt.signal?.aborted) onAbort();
        });
      },
    };
    try {
      await this.#login(login.snapshot.provider, interaction, () => this.#deviceId);
      if (!login.controller.signal.aborted) {
        login.snapshot.state = 'succeeded';
        login.snapshot.message = 'Subscription login saved';
        login.snapshot.prompt = null;
      }
    } catch {
      login.snapshot.state = login.controller.signal.aborted ? 'cancelled' : 'failed';
      login.snapshot.message = login.controller.signal.aborted ? 'Login cancelled' : 'Login failed; retry or check provider authorization';
      login.snapshot.prompt = null;
    }
  }
}
