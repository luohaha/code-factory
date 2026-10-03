import { createInterface } from 'node:readline/promises';

import type { AuthPrompt } from '@earendil-works/pi-ai';

import { createNativeModels, NativeCredentialStore, nativeAuthDatabasePath } from './native-auth.js';

export async function runNativeAuthCommand(args: readonly string[], nativeConversationDatabasePath: string): Promise<void> {
  const action = args[0];
  if (action !== 'login' && action !== 'status' && action !== 'logout') {
    throw new TypeError('Usage: code-factory-agent-manager auth <login openai|login openai-codex|status|logout openai|logout openai-codex> [--config PATH] [--db PATH]');
  }
  const providerId = args[1];
  if ((action === 'login' || action === 'logout') && providerId !== 'openai' && providerId !== 'openai-codex') {
    throw new TypeError('Native subscription login supports openai and openai-codex');
  }
  const credentials = new NativeCredentialStore(nativeAuthDatabasePath(nativeConversationDatabasePath));
  const models = createNativeModels(credentials);
  try {
    if (action === 'status') {
      for (const provider of models.getProviders()) {
        const auth = await models.checkAuth(provider.id);
        process.stdout.write(`${provider.id}: ${auth ? `${auth.type} (${auth.source ?? 'configured'})` : 'not configured'}\n`);
      }
      return;
    }
    if (action === 'logout') {
      await models.logout(providerId!);
      process.stdout.write(`${providerId} subscription login removed.\n`);
      return;
    }

    const controller = new AbortController();
    const interrupt = () => controller.abort(new Error('Login cancelled'));
    process.once('SIGINT', interrupt);
    const readline = createInterface({ input: process.stdin, output: process.stdout });
    const ask = async (prompt: AuthPrompt): Promise<string> => {
      if (prompt.type === 'select') {
        process.stdout.write(`${prompt.message}\n`);
        for (const [index, option] of prompt.options.entries()) process.stdout.write(`  ${index + 1}. ${option.label}\n`);
        const answer = await readline.question(`Choose 1-${prompt.options.length} (default 1): `, { signal: prompt.signal });
        const selected = prompt.options[answer.trim() ? Number(answer.trim()) - 1 : 0];
        if (!selected) throw new TypeError('Invalid login method');
        return selected.id;
      }
      return readline.question(`${prompt.message} `, { signal: prompt.signal });
    };
    try {
      await models.login(providerId!, 'oauth', {
        signal: controller.signal,
        prompt: ask,
        notify: (event) => {
          if (event.type === 'auth_url') process.stdout.write(`Open this URL to sign in: ${event.url}\n`);
          else if (event.type === 'device_code') process.stdout.write(`Open ${event.verificationUri} and enter code ${event.userCode}\n`);
          else process.stdout.write(`${event.message}\n`);
        },
      });
      process.stdout.write(`${providerId} subscription login saved for this workspace.\n`);
    } finally {
      readline.close();
      process.removeListener('SIGINT', interrupt);
    }
  } finally {
    await credentials.close();
  }
}
