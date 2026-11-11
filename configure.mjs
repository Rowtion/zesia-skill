import { portableEnvironment } from './runtime.mjs';
process.env.ZESIA_CONFIG = portableEnvironment().ZESIA_CONFIG;
await import('./scripts/configure-shared.mjs');
