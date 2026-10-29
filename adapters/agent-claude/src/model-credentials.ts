// Model credential provider (exit criteria G3/G5).
//
// The agent needs a model API credential, and the agent is the one component
// the harness does not trust. So the credential never reaches it: the provider
// asks this port for a credential per attempt, hands it to the attempt's egress
// proxy on STDIN, and the proxy substitutes it into each model API request. The
// agent container only ever holds a placeholder.
//
// The port is asked per (scope, attempt) so a deployment can back it with a
// vault that mints a scoped, short-lived key per attempt. The file provider
// below is the minimal implementation: one key, read from a file on every call
// (so rotation needs no restart), never cached, never logged.

import { readFile, stat } from 'node:fs/promises';
import type { AttemptId, TenantScope } from '@asep/contracts';

export interface ModelCredential {
  // The secret. Delivered to the egress proxy only; never put in argv, an
  // environment variable, a log line, an artifact or an audit record.
  readonly apiKey: string;
  // The model API origin the proxy forwards to (ANTHROPIC_BASE_URL upstream).
  readonly baseUrl: string;
}

export interface ModelCredentialProvider {
  credentialFor(input: { scope: TenantScope; attemptId: AttemptId }): Promise<ModelCredential>;
}

export class ModelCredentialError extends Error {
  constructor(reason: string) {
    // Never include credential material in the message.
    super(`model credential unavailable: ${reason}`);
    this.name = 'ModelCredentialError';
  }
}

export const DEFAULT_MODEL_BASE_URL = 'https://api.anthropic.com';

/** Validate a model API origin: http(s), no credentials, query or fragment. */
export function parseModelBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ModelCredentialError(`base URL '${raw}' is not a URL`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ModelCredentialError(`base URL must be http(s), got '${url.protocol}'`);
  }
  if (url.username !== '' || url.password !== '') {
    throw new ModelCredentialError('base URL must not carry userinfo');
  }
  if (url.search !== '' || url.hash !== '') {
    throw new ModelCredentialError('base URL must not carry a query or fragment');
  }
  return url.toString().replace(/\/+$/, '');
}

export class FileModelCredentialProvider implements ModelCredentialProvider {
  private readonly baseUrl: string;

  constructor(private readonly cfg: { readonly apiKeyFile: string; readonly baseUrl?: string }) {
    if (typeof cfg.apiKeyFile !== 'string' || cfg.apiKeyFile.trim() === '') {
      throw new ModelCredentialError('no API key file configured');
    }
    this.baseUrl = parseModelBaseUrl(cfg.baseUrl ?? DEFAULT_MODEL_BASE_URL);
  }

  async credentialFor(): Promise<ModelCredential> {
    let mode: number;
    try {
      mode = (await stat(this.cfg.apiKeyFile)).mode;
    } catch {
      throw new ModelCredentialError(`API key file ${this.cfg.apiKeyFile} cannot be read`);
    }
    // Same rule ssh applies to private keys: a key file other users can read is
    // already disclosed, so refuse it rather than use it.
    if (process.platform !== 'win32' && (mode & 0o077) !== 0) {
      throw new ModelCredentialError(
        `API key file ${this.cfg.apiKeyFile} is accessible to group/other (mode ${(mode & 0o777).toString(8)}); chmod 600 it`,
      );
    }
    const apiKey = (await readFile(this.cfg.apiKeyFile, 'utf8')).trim();
    if (apiKey === '' || /\s/.test(apiKey)) {
      throw new ModelCredentialError(`API key file ${this.cfg.apiKeyFile} does not hold a single key`);
    }
    return { apiKey, baseUrl: this.baseUrl };
  }
}

/** Replace every occurrence of each secret with a fixed marker. */
export function redactSecrets(text: string, secrets: readonly string[]): { text: string; redacted: boolean } {
  let out = text;
  let redacted = false;
  for (const s of secrets) {
    if (s.length === 0) continue;
    if (out.includes(s)) {
      redacted = true;
      out = out.split(s).join('[REDACTED-MODEL-CREDENTIAL]');
    }
  }
  return { text: out, redacted };
}
