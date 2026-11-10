import type { ProviderRepository, ProviderRepositoryList, TokenGitProvider } from '../../../../../packages/shared/src/repositories.js';

export interface GitCredential {
  id: string;
  provider: TokenGitProvider;
  host: string;
  organization: string;
  username: string | null;
  token: string;
}

export interface RepositoryRef {
  id: string;
  fullName: string;
}

export interface GitProviderAdapter {
  verify(credential: GitCredential): Promise<{ login: string }>;
  list(credential: GitCredential): Promise<ProviderRepositoryList>;
  repository(credential: GitCredential, repository: RepositoryRef): Promise<ProviderRepository>;
  commit(credential: GitCredential, repository: RepositoryRef, ref: string): Promise<string>;
}
