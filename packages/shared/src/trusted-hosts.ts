export interface TrustedHost {
  connectorId: string;
  trustedAt: string;
}

export interface TrustedHostsResponse {
  hosts: TrustedHost[];
}

export const trustedHostsLocation = "Settings → Hosts → Shared with you → the host → Trust with my account";
