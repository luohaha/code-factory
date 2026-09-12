import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { isLogLevel, type LogLevel } from './logger.js';

export interface AgentManagerConfiguration {
  host: string;
  port: number;
  allowedOrigin: string | null;
  openDashboard: boolean;
  databasePath: string | null;
  pullRequestReconcileIntervalSeconds: number;
  logLevel: LogLevel;
  logFilePath: string | null;
  logMaxSize: string | number;
  logMaxFiles: string | number;
}

export type AgentManagerConfigurationPatch = Partial<AgentManagerConfiguration>;

export interface AgentManagerConfigurationSnapshot {
  path: string | null;
  values: AgentManagerConfiguration;
  restartRequired: boolean;
  restartRequiredFields: Array<keyof AgentManagerConfiguration>;
}

export const MAX_PULL_REQUEST_RECONCILE_INTERVAL_SECONDS = Math.floor(2_147_483_647 / 1_000);

export const DEFAULT_AGENT_MANAGER_CONFIGURATION: Readonly<AgentManagerConfiguration> = {
  host: '127.0.0.1',
  port: 4310,
  allowedOrigin: 'http://localhost:3000',
  openDashboard: false,
  databasePath: null,
  pullRequestReconcileIntervalSeconds: 30,
  logLevel: 'info',
  logFilePath: null,
  logMaxSize: '20m',
  logMaxFiles: '14d',
};

export const DYNAMIC_CONFIGURATION_FIELDS: ReadonlySet<keyof AgentManagerConfiguration> = new Set([
  'pullRequestReconcileIntervalSeconds',
  'logLevel',
]);

const configurationFields = new Set<keyof AgentManagerConfiguration>(
  Object.keys(DEFAULT_AGENT_MANAGER_CONFIGURATION) as Array<keyof AgentManagerConfiguration>,
);

export function defaultWorkspaceDataDirectory(workspaceRoot: string): string {
  const key = createHash('sha256').update(workspaceRoot).digest('hex').slice(0, 16);
  return join(homedir(), '.code-factory', 'workspaces', key);
}

export function defaultConfigurationPath(workspaceRoot: string): string {
  return join(defaultWorkspaceDataDirectory(workspaceRoot), 'config.json');
}

export function loadAgentManagerConfiguration(path: string): AgentManagerConfiguration {
  const absolutePath = resolve(path);
  if (!existsSync(absolutePath)) {
    const configuration = { ...DEFAULT_AGENT_MANAGER_CONFIGURATION };
    writeAgentManagerConfiguration(absolutePath, configuration);
    return configuration;
  }

  let value: unknown;
  try {
    value = JSON.parse(readFileSync(absolutePath, 'utf8')) as unknown;
  } catch (error) {
    throw new TypeError(`Could not read Agent Manager configuration ${absolutePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return validateAgentManagerConfiguration(value);
}

export function writeAgentManagerConfiguration(path: string, value: AgentManagerConfiguration): void {
  const configuration = validateAgentManagerConfiguration(value);
  const absolutePath = resolve(path);
  const directory = dirname(absolutePath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = join(directory, `.${randomUUID()}.config.tmp`);
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(configuration, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    renameSync(temporaryPath, absolutePath);
  } catch (error) {
    try {
      if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    } catch {
      // Preserve the original configuration write error.
    }
    throw error;
  }
}

export function validateAgentManagerConfiguration(value: unknown): AgentManagerConfiguration {
  const patch = validateAgentManagerConfigurationPatch(value);
  return { ...DEFAULT_AGENT_MANAGER_CONFIGURATION, ...patch };
}

export function validateAgentManagerConfigurationPatch(value: unknown): AgentManagerConfigurationPatch {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Agent Manager configuration must be a JSON object');
  }
  const input = value as Record<string, unknown>;
  const unknownFields = Object.keys(input).filter((field) => !configurationFields.has(field as keyof AgentManagerConfiguration));
  if (unknownFields.length > 0) throw new TypeError(`Unknown configuration field: ${unknownFields.join(', ')}`);

  const output: AgentManagerConfigurationPatch = {};
  if (input.host !== undefined) output.host = nonEmptyString(input.host, 'host');
  if (input.port !== undefined) output.port = integerInRange(input.port, 'port', 1, 65_535);
  if (input.allowedOrigin !== undefined) output.allowedOrigin = nullableString(input.allowedOrigin, 'allowedOrigin');
  if (input.openDashboard !== undefined) {
    if (typeof input.openDashboard !== 'boolean') throw new TypeError('openDashboard must be a boolean');
    output.openDashboard = input.openDashboard;
  }
  if (input.databasePath !== undefined) output.databasePath = nullableString(input.databasePath, 'databasePath');
  if (input.pullRequestReconcileIntervalSeconds !== undefined) {
    output.pullRequestReconcileIntervalSeconds = integerInRange(
      input.pullRequestReconcileIntervalSeconds,
      'pullRequestReconcileIntervalSeconds',
      0,
      MAX_PULL_REQUEST_RECONCILE_INTERVAL_SECONDS,
    );
  }
  if (input.logLevel !== undefined) {
    if (!isLogLevel(input.logLevel)) throw new TypeError('logLevel must be debug, info, warn, error, or silent');
    output.logLevel = input.logLevel;
  }
  if (input.logFilePath !== undefined) output.logFilePath = nullableString(input.logFilePath, 'logFilePath');
  if (input.logMaxSize !== undefined) output.logMaxSize = logMaxSize(input.logMaxSize);
  if (input.logMaxFiles !== undefined) output.logMaxFiles = logMaxFiles(input.logMaxFiles);
  return output;
}

function nonEmptyString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} must be a non-empty string`);
  return value.trim();
}

function nullableString(value: unknown, name: string): string | null {
  if (value === null) return null;
  return nonEmptyString(value, name);
}

function integerInRange(value: unknown, name: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new TypeError(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return Number(value);
}

function logMaxSize(value: unknown): string | number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value === 'string' && /^[1-9]\d*(?:[kmg])?$/i.test(value.trim())) return value.trim();
  throw new TypeError('logMaxSize must be a positive byte count or size such as 20m');
}

function logMaxFiles(value: unknown): string | number {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  if (typeof value === 'string' && /^[1-9]\d*d?$/.test(value.trim())) return value.trim();
  throw new TypeError('logMaxFiles must be a positive file count or day count such as 14d');
}
