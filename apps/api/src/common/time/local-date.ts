/** Jour calendaire (`AAAA-MM-JJ`) d'un instant dans un fuseau IANA : sert au « jour J » du tenant. */
export function localDateKey(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(instant);
}
