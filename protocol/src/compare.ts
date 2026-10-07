/** Orders strings by code unit and numbers by value. Never by locale, so the order is the same everywhere. */
export function compare(a: string | number, b: string | number): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
