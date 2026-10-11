import { describe, expect, it } from 'vitest';
import { buildPasswordResetEmail, passwordResetLink } from './password-reset-email';
import { buildMfaEmailCodeEmail, buildMfaResetEmail, buildPasswordChangedEmail, buildSuspiciousLoginEmail } from './security-emails';

const TOKEN = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b.AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde';
const base = { to: 'awa@test.sn', fullName: 'Awa <Diop>', tenantName: 'Clinique "Soleil"', tenantSlug: 'clinique-soleil', webUrl: 'http://localhost:3001/' };

describe('e-mail de réinitialisation du mot de passe', () => {
  const message = buildPasswordResetEmail({ ...base, token: TOKEN, ttlMinutes: 30 });

  it('compose le lien ${WEB_URL}/reinitialiser/<token> sans double barre oblique', () => {
    expect(passwordResetLink('http://localhost:3001/', TOKEN)).toBe(`http://localhost:3001/reinitialiser/${TOKEN}`);
    expect(message.text).toContain(`http://localhost:3001/reinitialiser/${TOKEN}`);
    expect(message.html).toContain(`http://localhost:3001/reinitialiser/${TOKEN}`);
  });

  it('indique la durée, le code établissement et la mention « pas à l’origine de la demande »', () => {
    expect(message.text).toContain('30 minutes');
    expect(message.text).toContain('Code établissement : clinique-soleil');
    expect(message.text).toMatch(/pas à l’origine de cette demande/);
    expect(message.to).toBe('awa@test.sn');
  });

  it('échappe le HTML des données saisies', () => {
    expect(message.html).not.toContain('<Diop>');
    expect(message.html).toContain('&#60;Diop&#62;');
    expect(message.html).toContain('&#34;Soleil&#34;');
  });
});

describe('e-mails de sécurité sans jeton', () => {
  const messages = [
    buildPasswordChangedEmail(base),
    buildSuspiciousLoginEmail(base),
    buildMfaResetEmail({ ...base, actorName: 'Admin <X>' }),
  ];

  it('ne portent aucun lien contenant un jeton', () => {
    for (const message of messages) {
      expect(message.text).not.toMatch(/[0-9a-f-]{36}\.[A-Za-z0-9_-]{20,}/);
      expect(message.html ?? '').not.toMatch(/reinitialiser\//);
    }
  });

  it('le message de tentatives inhabituelles renvoie vers /mot-de-passe-oublie', () => {
    expect(buildSuspiciousLoginEmail(base).text).toContain('http://localhost:3001/mot-de-passe-oublie');
  });

  it('échappent le HTML', () => {
    for (const message of messages) expect(message.html).not.toContain('<Diop>');
    expect(messages[2]!.html).not.toContain('<X>');
  });
});

describe('e-mail du code d’enrôlement', () => {
  it('porte le code à 6 chiffres et sa durée de validité', () => {
    const message = buildMfaEmailCodeEmail({ ...base, code: '012345', ttlMinutes: 10 });
    expect(message.text).toContain('012345');
    expect(message.text).toContain('10 minutes');
    expect(message.html).toContain('012345');
  });
});
