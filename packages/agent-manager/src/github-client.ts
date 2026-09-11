import { execFile } from 'node:child_process';

import type { PullRequest, PullRequestStatus } from './types.js';

export type GitHubReviewActivityKind = 'comment' | 'review' | 'review_comment';

export interface GitHubReviewActivity {
  kind: GitHubReviewActivityKind;
  id: string;
  author: string;
  body: string;
  url: string;
  createdAt: string;
  state: string | null;
  path: string | null;
  line: number | null;
}
export interface GitHubCheck {
  key: string;
  name: string;
  workflow: string | null;
  status: string;
  conclusion: string | null;
  url: string | null;
  completedAt: string | null;
}

export interface GitHubPullRequestSnapshot {
  status: PullRequestStatus;
  title: string;
  url: string;
  baseBranch: string;
  headBranch: string;
  headSha: string;
  updatedAt: string;
  reviewActivity: GitHubReviewActivity[];
  checks: GitHubCheck[];
}

export interface GitHubClient {
  inspectPullRequest(pullRequest: PullRequest): Promise<GitHubPullRequestSnapshot>;
}

type JsonObject = Record<string, unknown>;

function objectValue(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null;
}

function objectArray(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.flatMap((item) => {
    if (Array.isArray(item)) return objectArray(item);
    const object = objectValue(item);
    return object ? [object] : [];
  }) : [];
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function requiredString(value: unknown, field: string): string {
  const result = optionalString(value);
  if (!result) throw new TypeError(`GitHub response is missing ${field}`);
  return result;
}

function authorLogin(value: unknown): string {
  const author = objectValue(value);
  return optionalString(author?.login) ?? 'unknown';
}

function pullRequestStatus(state: unknown, isDraft: unknown): PullRequestStatus {
  if (state === 'MERGED') return 'merged';
  if (state === 'CLOSED') return 'closed';
  if (state === 'OPEN') return isDraft === true ? 'draft' : 'open';
  throw new TypeError(`Unsupported GitHub pull request state: ${String(state)}`);
}

function reviewActivity(value: JsonObject, kind: GitHubReviewActivityKind): GitHubReviewActivity | null {
  const id = optionalString(value.id) ?? (typeof value.id === 'number' ? String(value.id) : null);
  const createdAt = optionalString(value.submittedAt)
    ?? optionalString(value.createdAt)
    ?? optionalString(value.created_at)
    ?? optionalString(value.submitted_at);
  if (!id || !createdAt) return null;
  const lineValue = value.line ?? value.original_line;
  return {
    kind,
    id,
    author: authorLogin(value.author ?? value.user),
    body: optionalString(value.body) ?? '',
    url: optionalString(value.url) ?? optionalString(value.html_url) ?? '',
    createdAt,
    state: optionalString(value.state),
    path: optionalString(value.path),
    line: typeof lineValue === 'number' ? lineValue : null,
  };
}

function checkFrom(value: JsonObject): GitHubCheck | null {
  const type = optionalString(value.__typename) ?? 'Check';
  const name = optionalString(value.name) ?? optionalString(value.context);
  if (!name) return null;
  const workflow = optionalString(value.workflowName);
  const url = optionalString(value.detailsUrl) ?? optionalString(value.targetUrl);
  const status = optionalString(value.status) ?? optionalString(value.state) ?? 'UNKNOWN';
  const conclusion = optionalString(value.conclusion) ?? optionalString(value.state);
  return {
    key: [type, workflow ?? '', name, url ?? ''].join(':'),
    name,
    workflow,
    status,
    conclusion,
    url,
    completedAt: optionalString(value.completedAt),
  };
}

function repositoryApiTarget(repository: string): { hostname: string | null; path: string } {
  const parts = repository.split('/').filter(Boolean);
  if (parts.length !== 2 && parts.length !== 3) {
    throw new TypeError(`repository must be OWNER/REPO or HOST/OWNER/REPO, received ${repository}`);
  }
  const hostname = parts.length === 3 ? parts[0]! : null;
  const owner = parts.at(-2)!;
  const name = parts.at(-1)!;
  return {
    hostname,
    path: `repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
  };
}

export class GhCliGitHubClient implements GitHubClient {
  readonly #workspaceRoot: string;

  constructor(workspaceRoot: string) {
    this.#workspaceRoot = workspaceRoot;
  }

  async inspectPullRequest(pullRequest: PullRequest): Promise<GitHubPullRequestSnapshot> {
    const target = repositoryApiTarget(pullRequest.repository);
    const apiArgs = target.hostname ? ['--hostname', target.hostname] : [];
    const [detailsValue, reviewCommentsValue] = await Promise.all([
      this.runJson([
        'pr',
        'view',
        String(pullRequest.number),
        '--repo',
        pullRequest.repository,
        '--json',
        'state,isDraft,title,url,baseRefName,headRefName,headRefOid,updatedAt,comments,reviews,statusCheckRollup',
      ]),
      this.runJson([
        'api',
        ...apiArgs,
        '--paginate',
        '--slurp',
        `${target.path}/pulls/${pullRequest.number}/comments?per_page=100`,
      ]),
    ]);
    const details = objectValue(detailsValue);
    if (!details) throw new TypeError('GitHub pull request response must be an object');
    const activities = [
      ...objectArray(details.comments).map((value) => reviewActivity(value, 'comment')),
      ...objectArray(details.reviews).map((value) => reviewActivity(value, 'review')),
      ...objectArray(reviewCommentsValue).map((value) => reviewActivity(value, 'review_comment')),
    ].filter((value): value is GitHubReviewActivity => value !== null)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    return {
      status: pullRequestStatus(details.state, details.isDraft),
      title: requiredString(details.title, 'title'),
      url: requiredString(details.url, 'url'),
      baseBranch: requiredString(details.baseRefName, 'baseRefName'),
      headBranch: requiredString(details.headRefName, 'headRefName'),
      headSha: requiredString(details.headRefOid, 'headRefOid'),
      updatedAt: requiredString(details.updatedAt, 'updatedAt'),
      reviewActivity: activities,
      checks: objectArray(details.statusCheckRollup)
        .map(checkFrom)
        .filter((value): value is GitHubCheck => value !== null),
    };
  }

  private runJson(args: string[]): Promise<unknown> {
    return new Promise((resolve, reject) => {
      execFile('gh', args, {
        cwd: this.#workspaceRoot,
        env: process.env,
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
      }, (error, stdout, stderr) => {
        if (error) {
          const detail = String(stderr).trim() || error.message;
          reject(new Error(`gh ${args.slice(0, 2).join(' ')} failed: ${detail}`));
          return;
        }
        try {
          resolve(JSON.parse(String(stdout)) as unknown);
        } catch (parseError) {
          reject(new Error(`gh returned invalid JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`));
        }
      });
    });
  }
}
