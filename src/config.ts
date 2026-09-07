import { BridgeError } from './errors.js';

export type SecretSource = { kind: 'environment'; name: string } | { kind: 'keychain'; service: string; account: string };
export interface Config { readonly baseUrl: URL; readonly secret: SecretSource }
type Environment = Readonly<Record<string, string | undefined>>;
const invalid = () => new BridgeError('INVALID_CONFIG');

export function parseConfig(env: Environment): Config {
  const raw = env.HA_BASE_URL;
  if (!raw || raw.length > 2048 || /[\s\\]/u.test(raw)) throw invalid();
  let baseUrl: URL;
  try { baseUrl = new URL(raw); } catch { throw invalid(); }
  if (baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash || baseUrl.pathname !== '/' ||
      !['https:', 'http:'].includes(baseUrl.protocol)) throw invalid();
  if (baseUrl.protocol === 'http:' && env.HA_ALLOW_HTTP !== 'true') throw invalid();
  let secret: SecretSource;
  if (env.HA_TOKEN_SOURCE === 'environment') {
    const name = env.HA_TOKEN_ENV_NAME;
    if (!name || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name)) throw invalid();
    secret = { kind: 'environment', name };
  } else if (env.HA_TOKEN_SOURCE === 'keychain') {
    const service = env.HA_KEYCHAIN_SERVICE;
    const account = env.HA_KEYCHAIN_ACCOUNT;
    if (!service || !account || [service, account].some(v => v.length > 256 || /[\x00-\x1f\x7f]/.test(v))) throw invalid();
    secret = { kind: 'keychain', service, account };
  } else throw invalid();
  return { baseUrl, secret };
}

export function restUrl(config: Config, path: string, query: ReadonlyArray<readonly [string,string]> = []): URL {
  const bad = () => new BridgeError('INVALID_PATH');
  if (path.length > 2048 || path.startsWith('/') || /[:?#\\\s\x00-\x1f\x7f]/u.test(path)) throw bad();
  let decoded: string;
  try { decoded = decodeURIComponent(path); } catch { throw bad(); }
  // Reject nested encoding and encoded separators instead of trusting downstream normalization.
  if (decoded.includes('%') || /[:?#\\\x00-\x1f\x7f]/u.test(decoded) || /%2f/i.test(path) ||
      decoded.split('/').some(segment => segment === '..' || segment === '.')) throw bad();
  const url = new URL(`/api/${path}`, config.baseUrl);
  if (url.origin !== config.baseUrl.origin || !url.pathname.startsWith('/api/')) throw bad();
  if (query.length > 256) throw new BridgeError('INVALID_QUERY');
  for (const [key,value] of query) url.searchParams.append(key,value);
  if (url.href.length > 16384) throw new BridgeError('INVALID_QUERY');
  return url;
}
