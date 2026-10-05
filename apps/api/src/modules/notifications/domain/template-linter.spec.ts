import { describe, expect, it } from 'vitest';
import { FORBIDDEN_TERMS, findForbiddenTerms, normalizeForMatch } from './privacy-terms';
import { lintTemplate, type LintInput } from './template-linter';

const SMS: LintInput = {
  typeCode: 'appointment.confirmed',
  channel: 'sms',
  body: '{{etablissement.nom}} : rendez-vous confirmé le {{rdv.date}} à {{rdv.heure}}.',
  serviceNames: [],
  transliterate: true,
};

const codesOf = (input: LintInput): string[] => lintTemplate(input).map((issue) => issue.code);

describe('normalizeForMatch', () => {
  it('passe en minuscules et retire les accents', () => {
    expect(normalizeForMatch('HÉPATITE Santé Mentale')).toBe('hepatite sante mentale');
  });
});

describe('findForbiddenTerms', () => {
  it('liste au moins les termes du contrat', () => {
    for (const term of ['diagnostic', 'motif', 'vih', 'hiv', 'hépatite', 'santé mentale', 'séropositi', 'dr', 'docteur', 'doctor']) {
      expect(FORBIDDEN_TERMS).toContain(term);
    }
  });

  it('ignore la casse et les accents', () => {
    expect(findForbiddenTerms('Résultat de HÉPATITE')).toEqual(expect.arrayContaining(['résultat', 'hépatite']));
    expect(findForbiddenTerms('SANTE MENTALE')).toEqual(['santé mentale']);
  });

  it('reconnaît un radical dans un mot fléchi (résultats, psychiatrie, séropositivité)', () => {
    expect(findForbiddenTerms('vos résultats')).toContain('résultat');
    expect(findForbiddenTerms('service de psychiatrie')).toContain('psychiatr');
    expect(findForbiddenTerms('séropositivité')).toContain('séropositi');
  });

  it('ne déclenche pas les termes courts (dr, ist, std, ivg, vih) à l’intérieur d’un mot', () => {
    expect(findForbiddenTerms('adresse, distance, listing, student, divergent')).toEqual([]);
    expect(findForbiddenTerms('Dr Diop')).toContain('dr');
    expect(findForbiddenTerms('test IST')).toContain('ist');
  });

  it('ignore le contenu des variables {{…}}', () => {
    expect(findForbiddenTerms('{{rdv.date}} {{etablissement.nom}}')).toEqual([]);
  });

  it('retourne une liste vide pour un texte neutre', () => {
    expect(findForbiddenTerms('Rendez-vous confirmé à la clinique le 7 octobre à 10:00.')).toEqual([]);
  });
});

describe('lintTemplate : modèle valide', () => {
  it('ne signale rien pour un SMS conforme', () => {
    expect(lintTemplate(SMS)).toEqual([]);
  });

  it('ne signale rien pour un e-mail avec sujet', () => {
    const issues = lintTemplate({ ...SMS, channel: 'email', subject: 'Rendez-vous confirmé', body: 'Bonjour {{patient.prenom}}, rdv le {{rdv.date}}.' });

    expect(issues).toEqual([]);
  });
});

describe('lintTemplate : unknown_variable', () => {
  it('refuse une variable hors de la liste blanche du type', () => {
    const issues = lintTemplate({ ...SMS, body: 'Bonjour {{patient.nom}}, {{facture.numero}}' });

    expect(issues.filter((i) => i.code === 'unknown_variable')).toHaveLength(2);
    expect(issues[0]).toMatchObject({ path: 'body', code: 'unknown_variable' });
  });

  it('applique la liste blanche propre au type (lien accepté pour une relance, pas pour un rendez-vous)', () => {
    const reminder = { ...SMS, typeCode: 'subscription.payment_reminder' as const, channel: 'email' as const, subject: 'Facture {{facture.numero}}', body: '{{lien}}' };

    expect(codesOf(reminder)).toEqual([]);
    expect(codesOf({ ...SMS, body: '{{lien}}' })).toContain('unknown_variable');
  });

  it('signale une double accolade mal formée comme variable inconnue', () => {
    expect(codesOf({ ...SMS, body: 'Bonjour {{ nom complet }}' })).toContain('unknown_variable');
  });

  it('vérifie aussi le sujet', () => {
    const issues = lintTemplate({ ...SMS, channel: 'email', subject: 'Bonjour {{patient.nom}}', body: 'ok' });

    expect(issues).toContainEqual(expect.objectContaining({ path: 'subject', code: 'unknown_variable' }));
  });
});

describe('lintTemplate : forbidden_term', () => {
  it('refuse un terme clinique, sans tenir compte de la casse ni des accents', () => {
    expect(codesOf({ ...SMS, body: 'Votre RESULTAT est prêt' })).toContain('forbidden_term');
    expect(codesOf({ ...SMS, body: 'Consultation de Psychiatrie' })).toContain('forbidden_term');
    expect(codesOf({ ...SMS, body: 'Test de dépistage' })).toContain('forbidden_term');
    expect(codesOf({ ...SMS, body: 'Test de DEPISTAGE' })).toContain('forbidden_term');
  });

  it('refuse un titre de médecin en français et en anglais', () => {
    expect(codesOf({ ...SMS, body: 'Avec le Dr Ndiaye' })).toContain('forbidden_term');
    expect(codesOf({ ...SMS, body: 'Avec le docteur' })).toContain('forbidden_term');
    expect(codesOf({ ...SMS, body: 'With the doctor' })).toContain('forbidden_term');
  });

  it('inspecte le sujet', () => {
    const issues = lintTemplate({ ...SMS, channel: 'email', subject: 'Votre diagnostic', body: 'ok' });

    expect(issues).toContainEqual(expect.objectContaining({ path: 'subject', code: 'forbidden_term' }));
  });

  it('nomme le terme trouvé dans le message', () => {
    const [issue] = lintTemplate({ ...SMS, body: 'Votre ordonnance' });

    expect(issue?.message).toContain('ordonnance');
  });
});

describe('lintTemplate : service_name', () => {
  it('refuse le nom d’un service de l’établissement (4 caractères ou plus)', () => {
    expect(codesOf({ ...SMS, body: 'Rdv au service Cardiologie', serviceNames: ['Cardiologie'] })).toContain('service_name');
    expect(codesOf({ ...SMS, body: 'RDV AU SERVICE PEDIATRIE', serviceNames: ['Pédiatrie'] })).toContain('service_name');
  });

  it('ignore les noms de service de moins de 4 caractères', () => {
    expect(codesOf({ ...SMS, body: 'Rdv au ORL', serviceNames: ['ORL'] })).not.toContain('service_name');
  });

  it('ne signale rien quand aucun nom de service n’apparaît', () => {
    expect(codesOf({ ...SMS, serviceNames: ['Cardiologie'] })).toEqual([]);
  });
});

describe('lintTemplate : sujet', () => {
  it('exige un sujet pour l’e-mail et l’in-app', () => {
    expect(codesOf({ ...SMS, channel: 'email', body: 'ok' })).toContain('subject_required');
    expect(codesOf({ ...SMS, channel: 'email', subject: '   ', body: 'ok' })).toContain('subject_required');
    expect(codesOf({ ...SMS, typeCode: 'quota.sms_threshold', channel: 'inapp', body: 'ok' })).toContain('subject_required');
  });

  it('interdit un sujet pour un SMS', () => {
    expect(codesOf({ ...SMS, subject: 'Sujet' })).toContain('subject_forbidden');
  });
});

describe('lintTemplate : longueurs', () => {
  it('refuse un SMS de plus de 3 segments (valeurs de longueur maximale)', () => {
    const issues = lintTemplate({ ...SMS, body: 'x'.repeat(461) });

    expect(issues).toContainEqual(expect.objectContaining({ path: 'body', code: 'too_many_segments' }));
  });

  it('accepte 459 caractères GSM-7 (3 segments)', () => {
    expect(codesOf({ ...SMS, body: 'x'.repeat(459) })).toEqual([]);
  });

  it('compte en UCS-2 quand la translittération est désactivée et que le texte contient ê', () => {
    expect(codesOf({ ...SMS, transliterate: false, body: 'ê'.repeat(202) })).toContain('too_many_segments');
    expect(codesOf({ ...SMS, transliterate: true, body: 'ê'.repeat(202) })).toEqual([]);
  });

  it('tient compte de la longueur maximale des valeurs substituées', () => {
    const body = '{{etablissement.nom}} {{site.nom}} {{patient.prenom}} {{rdv.date}} {{rdv.heure}} '.repeat(5);

    expect(codesOf({ ...SMS, body })).toContain('too_many_segments');
  });

  it('refuse un corps in-app de plus de 500 caractères et un titre de plus de 120', () => {
    const inapp: LintInput = { ...SMS, typeCode: 'quota.sms_threshold', channel: 'inapp', subject: 'Titre', body: 'x'.repeat(501) };

    expect(lintTemplate(inapp)).toContainEqual(expect.objectContaining({ path: 'body', code: 'too_long' }));
    expect(lintTemplate({ ...inapp, subject: 'T'.repeat(121), body: 'ok' })).toContainEqual(expect.objectContaining({ path: 'subject', code: 'too_long' }));
  });

  it('refuse un sujet d’e-mail de plus de 150 caractères après substitution', () => {
    const issues = lintTemplate({ ...SMS, channel: 'email', subject: 'S'.repeat(148) + '{{rdv.heure}}', body: 'ok' });

    expect(issues).toContainEqual(expect.objectContaining({ path: 'subject', code: 'too_long' }));
  });
});
