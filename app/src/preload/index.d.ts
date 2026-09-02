export interface AgentoAPI {
  /** Proof-of-wiring endpoint: main answers on the `agento:ping` channel. */
  ping: () => Promise<string>
}

declare global {
  interface Window {
    agento: AgentoAPI
  }
}
