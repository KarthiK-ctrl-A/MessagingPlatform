/** Express `trust proxy`: a hop count, `true`/`false`, or a comma-separated list of proxy addresses. */
export function trustProxySetting(value: string | undefined): boolean | number | string {
  if (!value || value === 'false') return false;
  if (value === 'true') return true;
  return /^\d+$/.test(value) ? Number(value) : value;
}
