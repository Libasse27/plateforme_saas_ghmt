/** Moteur de modèles maison, strict et sans logique : seules les variables `{{a.b}}` sont interprétées (docs/10 D12). */

export class TemplateRenderError extends Error {
  constructor(readonly variable: string) {
    super(`Valeur manquante ou placeholder invalide : ${variable}`);
    this.name = 'TemplateRenderError';
  }
}

const VARIABLE_SOURCE = String.raw`\{\{\s*([a-z_]+(?:\.[a-z_]+)*)\s*\}\}`;
const OPENING = '{{';

const variablePattern = (): RegExp => new RegExp(VARIABLE_SOURCE, 'g');

/** Noms de variables uniques, dans l'ordre d'apparition. */
export function extractVariables(template: string): string[] {
  const names = Array.from(template.matchAll(variablePattern()), (match) => match[1] as string);
  return [...new Set(names)];
}

/** Occurrences de `{{` qui ne forment pas une variable valide (casse, espaces, accolade non fermée…). */
export function findMalformedPlaceholders(template: string): string[] {
  const valid = variablePattern();
  const malformed: string[] = [];
  let from = 0;
  for (let open = template.indexOf(OPENING, from); open !== -1; open = template.indexOf(OPENING, from)) {
    valid.lastIndex = open;
    const match = valid.exec(template);
    if (match && match.index === open) {
      from = open + match[0].length;
      continue;
    }
    const close = template.indexOf('}}', open);
    const end = close === -1 ? template.length : close + 2;
    malformed.push(template.slice(open, end));
    from = end;
  }
  return malformed;
}

/** Rendu strict : toute valeur absente (ou vide) ou tout placeholder mal formé lève `TemplateRenderError`. */
export function renderTemplate(template: string, values: Readonly<Record<string, string | undefined>>): string {
  const [malformed] = findMalformedPlaceholders(template);
  if (malformed !== undefined) throw new TemplateRenderError(malformed);
  return template.replace(variablePattern(), (_whole, name: string) => {
    const value = values[name];
    if (value === undefined || value === '') throw new TemplateRenderError(name);
    return value;
  });
}

/** Rendu tolérant (aperçu) : les variables inconnues ou sans valeur disparaissent. */
export function renderLenient(template: string, values: Readonly<Record<string, string | undefined>>): string {
  return template.replace(variablePattern(), (_whole, name: string) => values[name] ?? '');
}

const HTML_ESCAPES: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] as string);
}

/** Version HTML d'un texte rendu : tout est échappé (valeurs comme texte du modèle), les retours à la ligne deviennent `<br>`. */
export function toEmailHtml(renderedText: string): string {
  return escapeHtml(renderedText).replace(/\r?\n/g, '<br>');
}
