/**
 * Many tests write a secret without choosing a data folder. A pinned key keeps them from making a key
 * file in the real one, where a live database may be.
 */
process.env.OPAL_SECRETS_KEY ??= 'test-only-secrets-key-0123456789abcdef';
