export interface ConnectorSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  readonly protocol: string;
  addEventListener(type: string, listener: (event: Event) => void): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type Generation = {
  socket: ConnectorSocket;
  abort: AbortController;
  done: PromiseWithResolvers<void>;
  welcome: PromiseWithResolvers<string>;
  connectionToken?: string;
  active: Set<Promise<void>>;
  tail: Promise<void>;
  waiting: Set<PromiseWithResolvers<"restarting">>;
  incomingBytes: number;
  reason?: string;
  runtimeReady: PromiseWithResolvers<void>;
};
