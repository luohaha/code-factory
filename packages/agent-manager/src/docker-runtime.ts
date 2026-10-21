import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { accessSync, constants, existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

import type { AgentInvocation } from './adapters/types.js';
import { dockerResources } from './docker-resources.js';
import { dockerCodexAuth } from './docker-codex-auth.js';
import type { DockerResources } from './types.js';

const exec = promisify(execFile);
export const DOCKER_AGENT_PATH = '/opt/code-factory/node_modules/.bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

/** Pure argument construction: environment values never appear in docker's argv. */
export function dockerInvocation(input: {
  resources: DockerResources;
  invocation: AgentInvocation;
  name: string;
  cwd: string;
  paths?: readonly string[];
  environment: Readonly<Record<string, string | undefined>>;
  home?: string;
  uid?: number;
  gid?: number;
}): AgentInvocation {
  const resources = dockerResources(input.resources)!;
  const home = input.home ?? homedir();
  const paths = [...new Set([home, input.cwd, ...(input.paths ?? [])].map((path) => resolve(path)))];
  const mounts = paths.filter((path, index) => !paths.some((parent, other) =>
    index !== other && relative(parent, path) !== '' && !relative(parent, path).startsWith('..') && !isAbsolute(relative(parent, path))));
  const args = ['run', '--rm', '--init', '-i', '--name', input.name, '--pull', 'never',
    '--network', 'host', '--cpus', String(resources.cpus), '--memory', `${resources.memoryMb}m`,
    '--memory-swap', `${resources.memoryMb}m`, '--workdir', input.cwd,
    '--user', `${input.uid ?? process.getuid?.() ?? 1000}:${input.gid ?? process.getgid?.() ?? 1000}`];
  for (const path of mounts) {
    if (/[\r\n,]/.test(path)) throw new TypeError('Docker mount paths cannot contain commas or newlines');
    args.push('--mount', `type=bind,source=${path},target=${path}`);
  }
  for (const [key, value] of Object.entries(input.environment)) {
    if (value !== undefined && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) args.push('--env', key);
  }
  args.push('--entrypoint', input.invocation.command, resources.image, ...input.invocation.args);
  return { command: 'docker', args, input: input.invocation.input };
}

async function credential(command: string, args: string[], environment: NodeJS.ProcessEnv): Promise<string | undefined> {
  try {
    const result = await exec(command, args, { env: environment, timeout: 5000, maxBuffer: 1024 * 1024 });
    return result.stdout.trim() || undefined;
  } catch { return undefined; }
}

export interface DockerRun {
  invocation: AgentInvocation;
  environment: Record<string, string | undefined>;
  remove(): Promise<void>;
}

export async function prepareDockerRun(input: {
  resources: DockerResources;
  invocation: AgentInvocation;
  cwd: string;
  environment?: Readonly<Record<string, string>>;
  paths?: readonly string[];
}): Promise<DockerRun> {
  if (process.platform === 'win32') throw new TypeError('Docker resource isolation requires Linux or macOS');
  const dockerCommand = (process.env.PATH ?? '').split(delimiter).map((path) => join(path, 'docker')).find((path) => {
    try { accessSync(path, constants.X_OK); return true; } catch { return false; }
  });
  if (!dockerCommand) throw new TypeError('Docker CLI is not installed or is not on PATH');
  const name = `code-factory-${randomUUID()}`;
  const environment: NodeJS.ProcessEnv = { ...process.env, ...input.environment };
  environment.HOME = homedir();
  // Linux tools must precede mounted host launchers and macOS binaries.
  environment.PATH = `${DOCKER_AGENT_PATH}:${environment.PATH ?? ''}`;
  delete environment.NODE_OPTIONS;
  delete environment.NODE_PATH;
  // gh's normal credential lookup on the host can read the macOS keychain.
  if (!environment.GH_TOKEN && !environment.GITHUB_TOKEN) {
    const token = await credential('gh', ['auth', 'token', '--hostname', 'github.com'], process.env);
    if (token) environment.GH_TOKEN = token;
  }
  if (environment.GH_TOKEN || environment.GITHUB_TOKEN) {
    // Replace host-only credential helpers (for example osxkeychain) for HTTPS Git.
    const count = Number(environment.GIT_CONFIG_COUNT ?? 0);
    if (Number.isSafeInteger(count) && count >= 0) {
      environment[`GIT_CONFIG_KEY_${count}`] = 'credential.https://github.com.helper';
      environment[`GIT_CONFIG_VALUE_${count}`] = '';
      environment[`GIT_CONFIG_KEY_${count + 1}`] = 'credential.https://github.com.helper';
      environment[`GIT_CONFIG_VALUE_${count + 1}`] = '!gh auth git-credential';
      environment.GIT_CONFIG_COUNT = String(count + 2);
    }
  }
  if (process.platform === 'darwin' && input.invocation.command === 'claude'
    && !environment.CLAUDE_CODE_OAUTH_TOKEN && !environment.ANTHROPIC_API_KEY) {
    const saved = await credential('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], process.env);
    if (saved) {
      try {
        const value = JSON.parse(saved) as { claudeAiOauth?: { accessToken?: unknown } };
        if (typeof value.claudeAiOauth?.accessToken === 'string') environment.CLAUDE_CODE_OAUTH_TOKEN = value.claudeAiOauth.accessToken;
      } catch { /* File-backed credentials remain available through the home mount. */ }
    }
  }
  const paths = [...(input.paths ?? []), tmpdir(), environment.CODEX_HOME, environment.CLAUDE_CONFIG_DIR,
    environment.XDG_CONFIG_HOME, environment.XDG_DATA_HOME, environment.XDG_RUNTIME_DIR, environment.GH_CONFIG_DIR,
    environment.NODE_EXTRA_CA_CERTS, environment.SSL_CERT_FILE, environment.GIT_CONFIG_GLOBAL]
    .filter((path): path is string => Boolean(path && isAbsolute(path) && existsSync(path)));
  if (process.platform === 'linux' && environment.SSH_AUTH_SOCK && existsSync(environment.SSH_AUTH_SOCK)) paths.push(environment.SSH_AUTH_SOCK);
  const invocation = dockerInvocation({ ...input, name, paths, environment });
  const auth = input.invocation.command === 'codex' ? await dockerCodexAuth(environment) : null;
  if (auth?.mount) {
    invocation.args.splice(invocation.args.indexOf('--entrypoint'), 0, '--mount', auth.mount);
  }
  if (process.platform === 'darwin' && environment.SSH_AUTH_SOCK) {
    const imageIndex = invocation.args.indexOf('--entrypoint');
    invocation.args.splice(imageIndex, 0, '--mount', 'type=bind,source=/run/host-services/ssh-auth.sock,target=/run/host-services/ssh-auth.sock');
    environment.SSH_AUTH_SOCK = '/run/host-services/ssh-auth.sock';
  }
  const remove = async () => {
    // Removing the container kills every process in its cgroup, including detached tools.
    // Always await cleanup; killing only the local docker client leaves those running.
    try { await exec(dockerCommand, ['rm', '--force', name], { timeout: 10_000, maxBuffer: 1024 * 1024 }); }
    catch (error) {
      const detail = error as { stderr?: string };
      if (!detail.stderr?.includes('No such container')) throw new Error('Could not remove Docker agent container; check Docker daemon health');
    } finally { await auth?.close(); }
  };
  // Create before attaching so cancellation cannot race container creation.
  // An exited docker client alone is never evidence that its container stopped.
  invocation.args[0] = 'create';
  try {
    await exec(dockerCommand, invocation.args, { env: environment, timeout: 30_000, maxBuffer: 1024 * 1024 });
  } catch {
    await remove().catch(() => undefined);
    throw new Error(`Could not create Docker agent container. Start the local Docker daemon, enable host networking, and build/pull image ${input.resources.image}.`);
  }
  return { invocation: { command: dockerCommand, args: ['start', '--attach', '--interactive', name], input: input.invocation.input }, environment, remove };
}
