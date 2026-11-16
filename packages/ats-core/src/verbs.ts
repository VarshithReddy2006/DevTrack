const actionVerb = /^(?:accelerated|architected|automated|built|created|delivered|deployed|designed|developed|engineered|established|implemented|improved|increased|integrated|launched|led|maintained|managed|migrated|optimized|reduced|refactored|scaled|shipped|streamlined|tested)\b/i;

export function analyzeActionVerbs(bullets: readonly string[]): boolean[] {
  return bullets.map(bullet => actionVerb.test(bullet.trimStart()));
}
