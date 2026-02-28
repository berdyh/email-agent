export interface OAuthCredentials {
  clientId: string;
  clientSecret: string;
}

export interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // Unix timestamp ms
  scope: string;
}
