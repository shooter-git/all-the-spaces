/**
 * Looks for secrets in a creation's source before it's stored: keys, tokens and credential files
 * that must never end up in a snapshot. Findings name the file, line and kind — never the secret.
 */
export interface SecretFinding {
  path: string;
  line?: number;
  kind: string;
}

const PATTERNS: { kind: string; re: RegExp }[] = [
  {
    kind: 'a private key',
    re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY/,
  },
  { kind: 'an Anthropic key or sign-in token', re: /\bsk-ant-[\w-]{20,}/ },
  { kind: 'an OpenAI key', re: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/ },
  { kind: 'a GitHub token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})/ },
  { kind: 'an AWS access key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { kind: 'a Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { kind: 'a Slack token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { kind: 'a Stripe key', re: /\b[sr]k_live_[0-9a-zA-Z]{20,}/ },
  {
    kind: 'a sign-in token (JWT)',
    re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  },
  {
    kind: 'a password or key assigned in code',
    re: /(?:api[_-]?key|secret|access[_-]?token|auth[_-]?token|password|passwd)["']?\s*[:=]\s*["'][A-Za-z0-9_\-+/=.]{20,}["']/i,
  },
];

/** Files that hold credentials, whatever is in them. */
const CREDENTIAL_FILES: { kind: string; re: RegExp }[] = [
  { kind: 'an environment file', re: /(^|\/)\.env(\.[\w-]+)?$/ },
  { kind: "an AI assistant's sign-in file", re: /(^|\/)(\.credentials\.json|auth\.json)$/ },
  { kind: 'a key file', re: /(^|\/)(id_rsa|id_ed25519|id_ecdsa)$|\.(pem|key|p12|pfx)$/ },
  { kind: 'an npm login file', re: /(^|\/)\.npmrc$/ },
];

export function scanForSecrets(contents: Map<string, Uint8Array>): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const [path, data] of contents) {
    const file = CREDENTIAL_FILES.find((f) => f.re.test(path));
    if (file && !path.endsWith('.env.example')) {
      findings.push({ path, kind: file.kind });
      continue;
    }
    if (data.byteLength > 5 * 1024 * 1024 || isBinary(data)) continue;
    const lines = new TextDecoder().decode(data).split('\n');
    lines.forEach((text, i) => {
      for (const p of PATTERNS) {
        if (p.re.test(text)) {
          findings.push({ path, line: i + 1, kind: p.kind });
          break;
        }
      }
    });
  }
  return findings;
}

function isBinary(data: Uint8Array) {
  const n = Math.min(data.byteLength, 8192);
  for (let i = 0; i < n; i++) if (data[i] === 0) return true;
  return false;
}
