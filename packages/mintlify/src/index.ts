import { createDocsClient, type DocsClient } from './client.ts';
import { requireEnv } from '../../shared/src/index.ts';

export * from './client.ts';

export function docsClientFromEnv(): DocsClient {
  return createDocsClient({ url: requireEnv('DOCS_MCP_URL') });
}
