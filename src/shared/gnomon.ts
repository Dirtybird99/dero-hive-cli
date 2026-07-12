export interface GnomonConnection {
  endpoint: string;
  status: 'connected' | 'disconnected' | 'error';
  lastSeen: number;
  indexedContracts: number;
  indexedTransactions: number;
  networkVersion: string;
}

export interface ContractDiscovery {
  scid: string;
  name: string;
  deployHeight: number;
  functions: string[];
  relatedContracts: string[];
  telaApp?: { entry: string; documents: string[] };
  lastActivity: number;
}

export interface IndexQuery {
  kind: 'similar-contracts' | 'by-function' | 'by-transaction' | 'tela-apps';
  filter?: string;
  limit?: number;
}

export function gnomonIndexQuery(query: IndexQuery): string {
  switch (query.kind) {
    case 'similar-contracts':
      return `Similar DERO smart contracts matching pattern or bytecode similarity for: ${query.filter || ''}`;
    case 'by-function':
      return `Contracts containing function: ${query.filter || ''}`;
    case 'by-transaction':
      return `Transactions involving contract: ${query.filter || ''}`;
    case 'tela-apps':
      return `TELA dApps deployed on the network (limit: ${query.limit || 10})`;
    default:
      return `Gnomon index query: ${query.kind} ${query.filter || ''}`;
  }
}

export function formatGnomonDiscovery(contracts: ContractDiscovery[]): string {
  if (!contracts.length) return 'No contracts discovered.';
  return contracts.map(c =>
    `- **${c.name || c.scid}** (deployed at height ${c.deployHeight}, last active ${new Date(c.lastActivity).toISOString()})\n` +
    `  SCID: \`${c.scid}\`\n` +
    (c.telaApp ? `  TELA app: ${c.telaApp.entry}\n` : '') +
    (c.functions.length ? `  Functions: ${c.functions.join(', ')}\n` : '') +
    (c.relatedContracts.length ? `  Related: ${c.relatedContracts.join(', ')}\n` : '')
  ).join('\n');
}
