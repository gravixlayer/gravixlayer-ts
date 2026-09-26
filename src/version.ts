import { version } from '../package.json';

/** SDK version, read from `package.json` so a release can never drift from it. */
export const VERSION: string = version;
