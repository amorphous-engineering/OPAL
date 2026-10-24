/** Release version. The build passes `--define OPAL_VERSION='"x.y.z"'`. */
declare const OPAL_VERSION: string | undefined;

export const VERSION: string = typeof OPAL_VERSION === 'string' ? OPAL_VERSION : '0.0.0-dev';
