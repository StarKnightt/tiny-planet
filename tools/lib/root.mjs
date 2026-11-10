import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Project root (F:\tiny-planet). */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
