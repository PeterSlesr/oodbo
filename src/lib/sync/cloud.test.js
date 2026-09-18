import { describe, it, expect, vi } from 'vitest';
import { createCloud, CloudAuthError, CloudTransientError, CloudQuotaError } from './cloud.js';

// Minimal Response stand-in: { status, json() }.
const resp = (status, body) => ({ status, json: async () => body });

// Build a cloud client over a scripted fetch. `script` is an array of responses (or
// factories) consumed in order; getToken returns tokens in sequence (or a fixed string).
function make(script, { tokens = ['tok'] } = {}) {
  let i = 0, t = 0;
  const calls = [];
  const fetchImpl = vi.fn(async (url, opts) => {
    calls.push({ url, opts });
    const step = script[Math.min(i, script.length - 1)];
    i++;
    if (typeof step === 'function') return step(url, opts);
    return step;
  });
  const getToken = vi.fn(async () => tokens[Math.min(t++, tokens.length - 1)]);
  const cloud = createCloud({ getToken, fetchImpl });
  return { cloud, fetchImpl, getToken, calls };
}

describe('createCloud — happy paths', () => {
  it('list returns files[]', async () => {
    const { cloud } = make([resp(200, { files: [{ projectId: 'p1', rev: 'r1', cTag: 'c1' }] })]);
    expect(await cloud.list()).toEqual([{ projectId: 'p1', rev: 'r1', cTag: 'c1' }]);
  });

  it('load returns xml + revs', async () => {
    const { cloud } = make([resp(200, { xml: '<x/>', rev: 'r1', cTag: 'c1' })]);
    expect(await cloud.load('p1')).toEqual({ xml: '<x/>', rev: 'r1', cTag: 'c1' });
  });

  it('load 404 → { notFound:true } (not an error)', async () => {
    const { cloud } = make([resp(404, { error: 'nope' })]);
    expect(await cloud.load('p1')).toEqual({ notFound: true });
  });

  it('save returns rev + cTag and forwards ifMatch in the body', async () => {
    const { cloud, calls } = make([resp(200, { ok: true, rev: 'r2', cTag: 'c2' })]);
    const out = await cloud.save('p1', '<x/>', { ifMatch: 'etag1' });
    expect(out).toEqual({ ok: true, rev: 'r2', cTag: 'c2' });
    expect(JSON.parse(calls[0].opts.body)).toEqual({ projectId: 'p1', xml: '<x/>', ifMatch: 'etag1' });
  });

  it('save 412 → { precondition:true } (OneDrive CAS miss = row 4)', async () => {
    const { cloud } = make([resp(412, { error: 'precondition_failed' })]);
    expect(await cloud.save('p1', '<x/>', { ifMatch: 'stale' })).toEqual({ precondition: true });
  });

  it('attaches the bearer token', async () => {
    const { cloud, calls } = make([resp(200, { files: [] })]);
    await cloud.list();
    expect(calls[0].opts.headers.Authorization).toBe('Bearer tok');
  });
});

describe('createCloud — §10 error classification', () => {
  it('401 + needs_reauth → CloudAuthError immediately, no retry', async () => {
    const { cloud, fetchImpl } = make([resp(401, { needs_reauth: true })]);
    await expect(cloud.list()).rejects.toBeInstanceOf(CloudAuthError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);      // did NOT retry
  });

  it('plain 401 → one silent refresh + retry, then succeeds', async () => {
    const { cloud, fetchImpl, getToken } = make(
      [resp(401, {}), resp(200, { files: [{ projectId: 'p1' }] })],
      { tokens: ['stale', 'fresh'] },
    );
    expect(await cloud.list()).toEqual([{ projectId: 'p1' }]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(getToken).toHaveBeenCalledTimes(2);        // re-fetched a fresh token
  });

  it('401 twice → CloudAuthError (headlessly unrecoverable)', async () => {
    const { cloud } = make([resp(401, {}), resp(401, {})], { tokens: ['a', 'b'] });
    await expect(cloud.list()).rejects.toBeInstanceOf(CloudAuthError);
  });

  it('403 → CloudQuotaError', async () => {
    const { cloud } = make([resp(403, {})]);
    await expect(cloud.load('p1')).rejects.toBeInstanceOf(CloudQuotaError);
  });

  it('5xx and 429 → CloudTransientError', async () => {
    await expect(make([resp(500, {})]).cloud.list()).rejects.toBeInstanceOf(CloudTransientError);
    await expect(make([resp(429, {})]).cloud.list()).rejects.toBeInstanceOf(CloudTransientError);
  });

  it('network failure → CloudTransientError', async () => {
    const { cloud } = make([() => { throw new Error('ECONNREFUSED'); }]);
    await expect(cloud.list()).rejects.toBeInstanceOf(CloudTransientError);
  });

  it('abort/timeout → CloudTransientError', async () => {
    const { cloud } = make([() => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }]);
    await expect(cloud.list()).rejects.toBeInstanceOf(CloudTransientError);
  });

  it('no session token → CloudTransientError (retry later, not reauth)', async () => {
    const cloud = createCloud({ getToken: async () => null, fetchImpl: async () => resp(200, {}) });
    await expect(cloud.list()).rejects.toBeInstanceOf(CloudTransientError);
  });
});
