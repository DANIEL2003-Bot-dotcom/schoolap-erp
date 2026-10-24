/** Convention RDC : NOM POSTNOM Prénom */
export function studentFullName(s) {
  return [s.lastName?.toUpperCase(), s.middleName?.toUpperCase(), s.firstName].filter(Boolean).join(' ');
}
