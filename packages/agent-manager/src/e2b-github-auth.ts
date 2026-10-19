import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Call only for sandboxes provisioned from an explicitly trusted github.com URL. */
export async function e2bGitHubEnvironment(forwardToken: boolean): Promise<Record<string, string>> {
  if (!forwardToken) return {};
  const configuredToken = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (configuredToken) return { GH_TOKEN: configuredToken };
  try {
    const { stdout } = await execFileAsync('gh', ['auth', 'token', '--hostname', 'github.com'], {
      encoding: 'utf8', timeout: 5_000, maxBuffer: 64 * 1024, windowsHide: true,
    });
    const token = stdout.trim();
    return token ? { GH_TOKEN: token } : {};
  } catch {
    // A sandbox can still use its own gh login. Never surface CLI output containing credentials.
    return {};
  }
}
