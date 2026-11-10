import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { ConnectorRelayEnvelope } from './connector-transport.js';

export interface ConnectorHub {
  connect(request: IncomingMessage, socket: Duplex, head: Buffer, connectorId: string, credentialHash: string): Promise<void>;
  rpc(connectorId: string, envelope: ConnectorRelayEnvelope): Promise<Response>;
  status(connectorId: string, timeoutMs: number): Promise<boolean>;
  revoke(connectorId: string): Promise<void>;
  close(): Promise<void>;
}
