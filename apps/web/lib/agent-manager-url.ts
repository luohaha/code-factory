export const DEFAULT_AGENT_MANAGER_URL = 'http://127.0.0.1:4310';

export function normalizeManagerUrl(value: string): string {
  const url = new URL(value.trim());
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new TypeError('Only HTTP and HTTPS URLs are supported');
  return url.toString().replace(/\/$/, '');
}

export function defaultManagerUrlForLocation(location: Pick<Location, 'hostname' | 'port' | 'origin'>): string {
  // The standalone local development dashboard uses a separate Manager port.
  const isLocalDevelopment = ['localhost', '127.0.0.1', '0.0.0.0', '[::1]'].includes(location.hostname)
    && location.port === '3000';
  return isLocalDevelopment ? DEFAULT_AGENT_MANAGER_URL : location.origin;
}
