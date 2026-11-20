// Certificats de TEST fabriqués à la volée avec openssl : ils ne sont pas ceux d'Apple, ils servent
// uniquement à vérifier que nos cartes sont bien construites et signées.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export type TestCerts = {
  dir: string;
  wwdr: Buffer;
  signerCert: Buffer;
  signerKey: Buffer;
  /** Certificat auto-signé (pour un faux serveur HTTPS). */
  tlsCert: Buffer;
  tlsKey: Buffer;
  cleanup: () => void;
};

const openssl = (dir: string, ...args: string[]) => execFileSync("openssl", args, { cwd: dir, stdio: "pipe" });

export function createTestCerts(): TestCerts {
  const dir = mkdtempSync(path.join(tmpdir(), "wallet-certs-"));
  openssl(dir, "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "wwdr.key", "-out", "wwdr.pem", "-subj", "/CN=Test WWDR CA", "-days", "2");
  openssl(dir, "req", "-newkey", "rsa:2048", "-nodes", "-keyout", "signer.key", "-out", "signer.csr", "-subj", "/CN=Pass Type ID: pass.test.fidelite/OU=TEAM123456");
  openssl(dir, "x509", "-req", "-in", "signer.csr", "-CA", "wwdr.pem", "-CAkey", "wwdr.key", "-CAcreateserial", "-out", "signer.pem", "-days", "2");
  openssl(dir, "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "tls.key", "-out", "tls.pem", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1", "-days", "2");
  const read = (f: string) => readFileSync(path.join(dir, f));
  return {
    dir,
    wwdr: read("wwdr.pem"),
    signerCert: read("signer.pem"),
    signerKey: read("signer.key"),
    tlsCert: read("tls.pem"),
    tlsKey: read("tls.key"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Variables d'environnement Apple de test (certificats en base64, comme en vrai). */
export function appleTestEnv(certs: TestCerts, overrides: Record<string, string> = {}): Record<string, string> {
  return {
    APPLE_PASS_TYPE_ID: "pass.test.fidelite",
    APPLE_TEAM_ID: "TEAM123456",
    APPLE_ORGANIZATION_NAME: "Fidélité Test",
    APPLE_SIGNER_CERT_BASE64: certs.signerCert.toString("base64"),
    APPLE_SIGNER_KEY_BASE64: certs.signerKey.toString("base64"),
    APPLE_WWDR_CERT_BASE64: certs.wwdr.toString("base64"),
    NEXT_PUBLIC_APP_URL: "https://fidelite.test",
    ...overrides,
  };
}
