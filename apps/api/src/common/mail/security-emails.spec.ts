import { describe, expect, it } from 'vitest';
import { buildMfaEmailCodeEmail, buildPasswordChangedEmail, buildSuspiciousLoginEmail, escapeHtml, forgotPasswordLink } from './security-emails';

const BASE = { to: 'awa@test.sn', fullName: 'Awa <Diop>', tenantName: 'Clinique & Co', tenantSlug: 'clinique', webUrl: 'https://app.ghmt.test/' };

describe('buildSuspiciousLoginEmail', () => {
  it('annonce un délai d’au plus 15 minutes, que l’administrateur peut lever (docs/11 §14.2)', () => {
    const mail = buildSuspiciousLoginEmail(BASE);

    expect(mail.text).toContain('jusqu’à 15 minutes ; votre administrateur peut lever ce délai');
    expect(mail.html).toContain('jusqu’à 15 minutes ; votre administrateur peut lever ce délai');
  });

  it('renvoie vers la page publique de mot de passe oublié, sans jeton, et échappe les données saisies', () => {
    const mail = buildSuspiciousLoginEmail(BASE);

    expect(mail.text).toContain('https://app.ghmt.test/mot-de-passe-oublie');
    expect(mail.html).toContain('Awa &#60;Diop&#62;');
    expect(mail.html).not.toContain('<Diop>');
    expect(mail.subject).toBe('Tentatives de connexion inhabituelles — Clinique & Co');
  });
});

describe('autres e-mails de sécurité', () => {
  it('la confirmation de changement de mot de passe ne contient aucun lien', () => {
    const mail = buildPasswordChangedEmail(BASE);

    expect(mail.text).not.toMatch(/https?:\/\//);
    expect(mail.html).not.toContain('<a ');
  });

  it('le code d’enrôlement figure dans le texte avec sa durée de validité', () => {
    const mail = buildMfaEmailCodeEmail({ ...BASE, code: '123456', ttlMinutes: 10 });

    expect(mail.text).toContain(': 123456');
    expect(mail.text).toContain('10 minutes');
  });

  it('escapeHtml et forgotPasswordLink', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe('&#60;a href=&#34;x&#34;&#62;&#39;&#38;&#39;&#60;/a&#62;');
    expect(forgotPasswordLink('https://web.test///')).toBe('https://web.test/mot-de-passe-oublie');
  });
});
