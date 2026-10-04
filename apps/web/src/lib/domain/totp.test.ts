import { describe, expect, it } from 'vitest';
import { backupCodesOf, buildTotpSetup } from './totp';

describe('buildTotpSetup', () => {
  it('génère un QR code SVG en data URL et conserve la clé manuelle', async () => {
    const setup = await buildTotpSetup({ otpauthUrl: 'otpauth://totp/GHMT:root?secret=JBSWY3DPEHPK3PXP&issuer=GHMT', secret: 'JBSWY3DPEHPK3PXP' });
    expect(setup?.secret).toBe('JBSWY3DPEHPK3PXP');
    expect(setup?.qrDataUrl.startsWith('data:image/svg+xml;charset=utf-8,')).toBe(true);
  });
  it('refuse une réponse inattendue ou une URL qui n\'est pas otpauth://', async () => {
    expect(await buildTotpSetup(null)).toBeNull();
    expect(await buildTotpSetup({ otpauthUrl: 'https://evil.test', secret: 'x' })).toBeNull();
    expect(await buildTotpSetup({ otpauthUrl: 'otpauth://totp/x' })).toBeNull();
  });
  it('extrait les codes de secours', () => {
    expect(backupCodesOf({ backupCodes: ['A', 1, 'B'] })).toEqual(['A', 'B']);
    expect(backupCodesOf(undefined)).toEqual([]);
  });
});
