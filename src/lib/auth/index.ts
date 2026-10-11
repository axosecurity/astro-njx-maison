import { ConversoraAuthClient } from './client';

export * from './client';

/**
 * Singleton Auth Client instance configured for the Maison store
 */
export const authClient = new ConversoraAuthClient({
  authServerUrl: 'https://auth.conversora.io',
  tenantId: 'maison',
  redirectUri: typeof window !== 'undefined' ? `${window.location.origin}/auth/callback` : '',
});
