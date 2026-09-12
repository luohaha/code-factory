export interface StartupBannerOptions {
  workspaceRoot: string;
  configurationFilePath: string;
  databasePath: string;
  logFilePath: string | null;
  dashboardUrl: string;
  apiUrl: string;
  pullRequestReconcileIntervalSeconds: number;
}

export function formatStartupBanner(options: StartupBannerOptions): string {
  return [
    'Code Factory Agent Manager started',
    `Workspace: ${options.workspaceRoot}`,
    `Config:    ${options.configurationFilePath}`,
    `Database:  ${options.databasePath}`,
    `Logs:      ${options.logFilePath ?? 'custom logger'}`,
    `Dashboard: ${options.dashboardUrl}`,
    `API:       ${options.apiUrl}`,
    `PR reconciler: ${options.pullRequestReconcileIntervalSeconds > 0
      ? `every ${options.pullRequestReconcileIntervalSeconds}s`
      : 'disabled'}`,
    'Warning: headless agents run with the current user\'s full filesystem and network permissions.',
  ].join('\n');
}
