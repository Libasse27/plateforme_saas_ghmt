import { describe, expect, it } from 'vitest';
import { TemplateRenderError, escapeHtml, extractVariables, findMalformedPlaceholders, renderLenient, renderTemplate, toEmailHtml } from './template-engine';

describe('extractVariables', () => {
  it('liste les variables uniques dans l’ordre d’apparition, espaces tolérés', () => {
    expect(extractVariables('{{ rdv.date }} à {{rdv.heure}} le {{rdv.date}}')).toEqual(['rdv.date', 'rdv.heure']);
  });

  it('retourne une liste vide sans variable', () => {
    expect(extractVariables('Bonjour')).toEqual([]);
  });
});

describe('findMalformedPlaceholders', () => {
  it('détecte les doubles accolades qui ne forment pas une variable valide', () => {
    expect(findMalformedPlaceholders('Bonjour {{ nom complet }} et {{Rdv.Date}} et {{ }}')).toHaveLength(3);
    expect(findMalformedPlaceholders('{{ rdv.date }} ok')).toEqual([]);
    expect(findMalformedPlaceholders('{{ rdv.date')).toEqual(['{{ rdv.date']);
  });
});

describe('renderTemplate (strict)', () => {
  it('remplace chaque occurrence par sa valeur', () => {
    const text = renderTemplate('RDV le {{rdv.date}} à {{ rdv.heure }} ({{rdv.date}})', { 'rdv.date': '7 octobre', 'rdv.heure': '10:00' });

    expect(text).toBe('RDV le 7 octobre à 10:00 (7 octobre)');
  });

  it('échoue avec le nom de la variable quand une valeur manque', () => {
    expect(() => renderTemplate('Bonjour {{patient.prenom}}', {})).toThrow(TemplateRenderError);
    try {
      renderTemplate('Bonjour {{patient.prenom}}', {});
    } catch (error) {
      expect((error as TemplateRenderError).variable).toBe('patient.prenom');
    }
  });

  it('traite une valeur vide comme manquante', () => {
    expect(() => renderTemplate('{{site.nom}}', { 'site.nom': '' })).toThrow(TemplateRenderError);
  });

  it('échoue sur une double accolade mal formée plutôt que de l’envoyer telle quelle', () => {
    expect(() => renderTemplate('Bonjour {{ nom complet }}', { 'nom complet': 'x' })).toThrow(TemplateRenderError);
  });

  it('n’interprète pas le contenu des valeurs (pas de réinjection)', () => {
    expect(renderTemplate('{{site.nom}}', { 'site.nom': '{{patient.prenom}}' })).toBe('{{patient.prenom}}');
  });

  it('ne traite aucune logique : le texte hors variables est conservé tel quel', () => {
    expect(renderTemplate('{% if x %} $1 {rdv.date}', {})).toBe('{% if x %} $1 {rdv.date}');
  });
});

describe('renderLenient (aperçu)', () => {
  it('remplace les variables connues et supprime les inconnues', () => {
    expect(renderLenient('A {{rdv.date}} B {{inconnue}} C', { 'rdv.date': 'X' })).toBe('A X B  C');
  });
});

describe('échappement HTML', () => {
  it('échappe les caractères spéciaux HTML', () => {
    expect(escapeHtml(`<script>alert("x")</script> & 'o'`)).toBe('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;o&#39;');
  });

  it('toEmailHtml échappe puis convertit les retours à la ligne en <br>', () => {
    expect(toEmailHtml('Ligne <1>\nLigne 2')).toBe('Ligne &lt;1&gt;<br>Ligne 2');
  });

  it('un nom d’établissement piégé reste inerte dans la version HTML', () => {
    const text = renderTemplate('Bienvenue à {{etablissement.nom}}', { 'etablissement.nom': '<img src=x onerror=alert(1)>' });

    expect(toEmailHtml(text)).not.toContain('<img');
  });
});
