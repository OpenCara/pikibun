export interface ObjectStorage {
  readonly provider: StorageProviderName;
  put(key: string, body: Uint8Array, metadata: ObjectMetadata): Promise<void>;
  get(key: string): Promise<StoredObject | null>;
  delete(key: string): Promise<void>;
}

export interface ObjectMetadata {
  contentType: string;
  custom: Record<string, string>;
}

export interface StoredObject {
  body: Uint8Array;
  size: number;
  metadata: ObjectMetadata;
}

export const storageProviderNames = ['filesystem', 's3'] as const;
export type StorageProviderName = (typeof storageProviderNames)[number];
