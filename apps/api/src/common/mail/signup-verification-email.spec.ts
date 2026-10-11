import { describe, expect, it } from 'vitest';
import { buildSignupVerificationEmail, signupVerificationLink } from './signup-verification-email';

describe('e-mail de vérification d’inscription (docs/11 §6.1, §14.3.4)', () => {
  const params = {
    to: 'awa@test.sn',
    tenantSlug: 'clinique-soleil',
    webUrl: 'http://localhost:3001/',
    token: '0198a2b4-7c3d-7e11-8a52-3f6d2c9b1e04.secretsecretsecretsecret',
    ttlHours: 24,
  };

  it('construit le lien ${WEB_URL}/inscription/confirmer/<token> sans double barre oblique', () => {
    expect(signupVerificationLink('http://localhost:3001/', 'tid.secret')).toBe('http://localhost:3001/inscription/confirmer/tid.secret');
    const { text, html } = buildSignupVerificationEmail(params);
    expect(text).toContain(`http://localhost:3001/inscription/confirmer/${params.token}`);
    expect(html).toContain(`href="http://localhost:3001/inscription/confirmer/${params.token}"`);
  });

  it('indique le code établissement, la durée de validité et la mention « ignorez ce message »', () => {
    const { text, html, subject, to } = buildSignupVerificationEmail(params);
    expect(to).toBe('awa@test.sn');
    expect(text).toContain('Code établissement à saisir à la connexion : clinique-soleil');
    expect(html).toContain('<strong>clinique-soleil</strong>');
    expect(text).toContain('24 heures');
    expect(text).toContain('ignorez ce message');
    expect(subject).toBe('Confirmez votre inscription à GHMT');
  });

  it('utilise un libellé fixe : aucun nom saisi à l’inscription (établissement ou personne) n’y figure', () => {
    // Le gabarit n'accepte plus ces champs : un attaquant ne peut pas faire écrire son texte à une adresse tierce.
    const mail = buildSignupVerificationEmail({ ...params, fullName: 'Offre <b>gratuite</b>', tenantName: 'Cliquez ici' } as never);
    expect(mail.text + mail.html + mail.subject).not.toMatch(/Offre|Cliquez/);
    expect(mail.text.startsWith('Bonjour,')).toBe(true);
  });

  it('échappe le HTML (code établissement et lien)', () => {
    const { html } = buildSignupVerificationEmail({ ...params, tenantSlug: 'a"<b>' });
    expect(html).not.toContain('<b>');
  });

  it('n’expose le jeton qu’une seule fois dans le texte (le lien), jamais dans l’objet', () => {
    const { text, subject } = buildSignupVerificationEmail(params);
    expect(text.split(params.token)).toHaveLength(2);
    expect(subject).not.toContain(params.token);
  });
});
