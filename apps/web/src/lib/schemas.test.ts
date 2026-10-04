import { describe, expect, it } from 'vitest';
import { acceptInvitationSchema, changePasswordSchema, forceReasonSchema, isInvitationToken } from './schemas';

describe('forceReasonSchema', () => {
  it('accepte 3 à 500 caractères', () => {
    expect(forceReasonSchema.safeParse('Homonyme confirmé').success).toBe(true);
    expect(forceReasonSchema.safeParse('ab').success).toBe(false);
    expect(forceReasonSchema.safeParse('x'.repeat(501)).success).toBe(false);
  });
});

describe('changePasswordSchema', () => {
  it('exige un nouveau mot de passe d\'au moins 10 caractères, différent de l\'actuel', () => {
    expect(changePasswordSchema.safeParse({ currentPassword: 'ancien-mdp-1', newPassword: 'nouveau-mdp-123' }).success).toBe(true);
    expect(changePasswordSchema.safeParse({ currentPassword: 'x', newPassword: 'court' }).success).toBe(false);
    const same = changePasswordSchema.safeParse({ currentPassword: 'meme-mot-de-passe', newPassword: 'meme-mot-de-passe' });
    expect(same.success).toBe(false);
  });
  it('refuse un mot de passe actuel vide', () => {
    expect(changePasswordSchema.safeParse({ currentPassword: '', newPassword: 'nouveau-mdp-123' }).success).toBe(false);
  });
});

describe('acceptInvitationSchema', () => {
  it('valide la longueur du mot de passe', () => {
    expect(acceptInvitationSchema.safeParse({ password: 'un-mot-de-passe' }).success).toBe(true);
    expect(acceptInvitationSchema.safeParse({ password: 'court' }).success).toBe(false);
    expect(acceptInvitationSchema.safeParse({ password: 'x'.repeat(129) }).success).toBe(false);
  });
});

describe('isInvitationToken', () => {
  it('accepte <tenantId>.<secret> et refuse le reste', () => {
    expect(isInvitationToken('0b9c0e1e-2d7a-4c3b-9a55-0f2b6f1e8a11.' + 'A'.repeat(43))).toBe(true);
    expect(isInvitationToken('../../etc')).toBe(false);
    expect(isInvitationToken('court')).toBe(false);
    expect(isInvitationToken('a/b?c')).toBe(false);
  });
});
