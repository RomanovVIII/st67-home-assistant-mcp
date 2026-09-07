import { describe, it, expect } from 'vitest';
import { parseConfig, restUrl } from '../src/config.js';
import { redact } from '../src/redaction.js';

const env = { HA_BASE_URL: 'https://ha.example.invalid', HA_TOKEN_SOURCE: 'environment', HA_TOKEN_ENV_NAME: 'TEST_TOKEN' };
describe('configuration and destination boundary', () => {
  it('keeps secrets out of parsed configuration and builds repeated query parameters', () => {
    const config = parseConfig({ ...env, TEST_TOKEN: 'synthetic-secret-value' });
    expect(JSON.stringify(config)).not.toContain('synthetic-secret-value');
    expect(restUrl(config, 'states/light.example', [['filter','one'],['filter','two']]).href)
      .toBe('https://ha.example.invalid/api/states/light.example?filter=one&filter=two');
  });
  it.each(['https://user:password@ha.example.invalid', 'https://ha.example.invalid/prefix', 'https://ha.example.invalid/?x=y', 'http://ha.example.invalid', 'file:///tmp/example'])('rejects unsafe root %s', base => {
    expect(() => parseConfig({ ...env, HA_BASE_URL: base })).toThrow();
  });
  it('requires complete configuration and explicit plaintext opt-in', () => {
    expect(() => parseConfig({})).toThrow();
    expect(() => parseConfig({ ...env, HA_TOKEN_SOURCE: 'file' })).toThrow();
    expect(parseConfig({ ...env, HA_BASE_URL: 'http://127.0.0.1:8123', HA_ALLOW_HTTP: 'true' }).baseUrl.protocol).toBe('http:');
  });
  it.each(['../config','%2e%2e/config','%252e%252e/config','//elsewhere.invalid/path','https://elsewhere.invalid','states?x=1','states#x','states\\other','states/%2f../config','states/%00bad'])('blocks path escape %s', path => {
    expect(() => restUrl(parseConfig(env), path)).toThrow();
  });
  it('retains normal percent encoded entity names', () => {
    expect(restUrl(parseConfig(env), 'states/sensor.%D1%82%D0%B5%D1%81%D1%82').pathname).toBe('/api/states/sensor.%D1%82%D0%B5%D1%81%D1%82');
  });
});
describe('response sanitization', () => {
  it('removes credential fields and an echoed exact token in both keys and values', () => {
    const token='synthetic-token-123';
    const result=redact({ access_token:'other-secret', nested:{ password:'another-secret', note:`oops ${token}`, [token]:'value' }, value:42 },token);
    const text=JSON.stringify(result);
    expect(text).not.toContain(token);
    expect(text).not.toContain('other-secret');
    expect(text).not.toContain('another-secret');
    expect(result).toMatchObject({ value:42 });
  });
  it('handles text and deeply nested JSON safely', () => {
    expect(redact('Bearer synthetic-token', 'synthetic-token')).not.toContain('synthetic-token');
    let deep: unknown='synthetic-token';
    for(let i=0;i<200;i++) deep={ value:deep };
    expect(JSON.stringify(redact(deep,'synthetic-token'))).not.toContain('synthetic-token');
  });
});
