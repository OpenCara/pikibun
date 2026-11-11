// Packing archived sessions' files on their hosts (docs/backups.md#packing-archived-sessions).

// How long after a session is archived its files are packed automatically, where its workspace leaves that on.
export const automaticPackingDays = 7;

export interface PackingSettings {
  // Archived sessions' files are packed automatically, automaticPackingDays after archiving. On unless turned off.
  automatic: boolean;
}
