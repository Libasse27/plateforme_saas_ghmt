import { describe, expect, it } from 'vitest';
import { buildInvitationEmail, invitationLink } from './invitation-email';
import { MemoryMailer } from './memory-mailer';

describe('e-mail d’invitation', () => {
  const params = { to: 'awa@test.sn', fullName: 'Awa <Diop>', tenantName: 'Clinique "Soleil"', webUrl: 'http://localhost:3001/', token: 'tid.secret', ttlHours: 72 };

  it('construit le lien ${WEB_URL}/invitation/<token> sans double barre oblique', () => {
    expect(invitationLink('http://localhost:3001/', 'tid.secret')).toBe('http://localhost:3001/invitation/tid.secret');
    expect(buildInvitationEmail(params).text).toContain('http://localhost:3001/invitation/tid.secret');
  });

  it('échappe le HTML des données saisies', () => {
    const { html } = buildInvitationEmail(params);
    expect(html).not.toContain('<Diop>');
    expect(html).toContain('&#60;Diop&#62;');
  });
});

describe('MemoryMailer', () => {
  it('conserve les messages, retrouve le dernier par destinataire et simule une panne', async () => {
    const mailer = new MemoryMailer();
    await mailer.send({ to: 'a@x.sn', subject: 's1', text: 't1' });
    await mailer.send({ to: 'a@x.sn', subject: 's2', text: 't2' });
    expect(mailer.sent).toHaveLength(2);
    expect(mailer.lastTo('a@x.sn')?.subject).toBe('s2');
    expect(mailer.lastTo('b@x.sn')).toBeUndefined();

    mailer.failOnNextSend();
    await expect(mailer.send({ to: 'a@x.sn', subject: 's3', text: 't3' })).rejects.toThrow();
    await expect(mailer.send({ to: 'a@x.sn', subject: 's4', text: 't4' })).resolves.toBeUndefined();
    mailer.clear();
    expect(mailer.sent).toHaveLength(0);
  });
});
