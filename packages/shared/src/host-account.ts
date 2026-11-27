export interface HostAccountSettings {
  othersHosts: boolean;
}

export const defaultHostAccount: HostAccountSettings = Object.freeze({ othersHosts: false });

export const hostAccountLocation = "Settings → Workspaces → Agents → Your account on others' hosts";
