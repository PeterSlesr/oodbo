import { describe, it, expect, beforeEach } from 'vitest';
import {
  createSecret, unlockWithPin, unlockWithRecovery, rewrapPin,
  setVaultKey, clearVaultKey, hasVaultKey, encodeEntry, decodeEntry,
} from './localVault.js';

describe('localVault (Model B)', () => {
  beforeEach(() => clearVaultKey());

  it('unlocks with the right PIN, rejects a wrong one', async () => {
    const { secret } = await createSecret('1234');
    expect(await unlockWithPin(secret, '1234')).toBeTruthy();
    expect(await unlockWithPin(secret, '9999')).toBeNull();
  });

  it('unlocks with the recovery code (grouping/case-insensitive)', async () => {
    const { secret, recoveryCode } = await createSecret('1234');
    expect(await unlockWithRecovery(secret, recoveryCode)).toBeTruthy();
    expect(await unlockWithRecovery(secret, recoveryCode.toLowerCase())).toBeTruthy();
    expect(await unlockWithRecovery(secret, recoveryCode.replace(/-/g, ''))).toBeTruthy();
    expect(await unlockWithRecovery(secret, 'NOPE-NOPE-NOPE')).toBeNull();
  });

  it('PIN reset via recovery keeps the SAME data key (recovery still valid, old PIN dead)', async () => {
    const { secret, recoveryCode } = await createSecret('1234');
    const dek = await unlockWithRecovery(secret, recoveryCode);
    const secret2 = await rewrapPin(secret, dek, '5678');
    expect(await unlockWithPin(secret2, '5678')).toBeTruthy();       // new PIN works
    expect(await unlockWithPin(secret2, '1234')).toBeNull();         // old PIN dead
    expect(await unlockWithRecovery(secret2, recoveryCode)).toBeTruthy(); // recovery survives
  });

  it('encrypts/decrypts an IDB entry round-trip with the active DEK', async () => {
    const { secret } = await createSecret('1234');
    const dek = await unlockWithPin(secret, '1234');
    setVaultKey(dek);
    expect(hasVaultKey()).toBe(true);

    const entry = { id: 'p1', owner: 'local:paul', pendingSync: true, lastSynced: null, data: { title: 'Secret draft', chapters: [{ content: 'hello world' }] } };
    const enc = await encodeEntry(entry);
    expect(enc.data).toBeNull();
    expect(enc.enc).toBeTruthy();
    expect(JSON.stringify(enc)).not.toContain('Secret draft');       // content not in the stored blob

    const dec = await decodeEntry(enc);
    expect(dec.data).toEqual(entry.data);
    expect(dec.enc).toBeUndefined();
  });

  it('is a transparent pass-through when no DEK is active (open accounts / web)', async () => {
    clearVaultKey();
    const entry = { id: 'p1', owner: 'local:paul', data: { title: 'open' } };
    expect(await encodeEntry(entry)).toBe(entry);                    // unchanged
    expect(await decodeEntry(entry)).toBe(entry);
  });

  it('a different account/DEK cannot read another account’s blob', async () => {
    const a = await createSecret('1111');
    const b = await createSecret('2222');
    setVaultKey(await unlockWithPin(a.secret, '1111'));
    const enc = await encodeEntry({ id: 'p1', owner: 'local:a', data: { title: 'A only' } });
    setVaultKey(await unlockWithPin(b.secret, '2222'));              // now B's key is active
    const dec = await decodeEntry(enc);
    expect(dec.data).toBeNull();                                     // B can't decrypt A's blob → stays opaque (no plaintext)
    expect(JSON.stringify(dec)).not.toContain('A only');
  });
});
