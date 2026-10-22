// Offline Sigstore test environment: a throwaway Fulcio CA, CT log and Rekor
// log from @sigstore/mock, served in-process through nock (no sockets, no
// network). Bundles are produced by the real @sigstore/sign client and a
// matching trusted_root.json is written, so the plug-in verifies them with
// the same @sigstore/verify code path it uses against the public-good root.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import nock from 'nock';
import { initializeCA, initializeCTLog, initializeTLog, fulcioHandler, rekorHandler } from '@sigstore/mock';
import { FulcioSigner, RekorWitness, MessageSignatureBundleBuilder } from '@sigstore/sign';
import { bundleToJSON } from '@sigstore/bundle';
import { TrustedRoot, HashAlgorithm, PublicKeyDetails } from '@sigstore/protobuf-specs';

const ec = () => crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const b64url = o => Buffer.from(JSON.stringify(o)).toString('base64url');

function serve(base, handler) {
  nock(base).persist().post(handler.path).reply(async (_uri, body) => {
    const r = await handler.fn(typeof body === 'string' ? body : JSON.stringify(body));
    return [r.statusCode, r.response, { 'Content-Type': r.contentType || 'text/plain' }];
  });
}

/** Build a CA + CT log + Rekor log and their trusted root. */
export async function createEnv({ fulcio: FULCIO = 'https://fulcio.speckl.test', rekor: REKOR = 'https://rekor.speckl.test' } = {}) {
  nock.disableNetConnect();
  const start = new Date(Date.now() - 60_000);
  const ctlog = await initializeCTLog(ec());
  const ca = await initializeCA(ec(), ctlog);
  const tlog = await initializeTLog(REKOR, ec());
  serve(FULCIO, fulcioHandler(ca));
  serve(REKOR, rekorHandler(tlog));
  const root = TrustedRoot.toJSON({
    mediaType: 'application/vnd.dev.sigstore.trustedroot+json;version=0.1',
    certificateAuthorities: [{
      subject: { commonName: 'speckl-test-fulcio', organization: 'speckl.test' },
      uri: FULCIO,
      certChain: { certificates: [{ rawBytes: Buffer.from(ca.rootCertificate.buffer) }] },
      validFor: { start },
    }],
    tlogs: [{
      baseUrl: REKOR,
      hashAlgorithm: HashAlgorithm.SHA2_256,
      publicKey: { rawBytes: tlog.publicKey, keyDetails: PublicKeyDetails.PKIX_ECDSA_P256_SHA_256, validFor: { start } },
      logId: { keyId: crypto.createHash('sha256').update(tlog.publicKey).digest() },
    }],
    ctlogs: [{
      baseUrl: 'https://ctfe.speckl.test',
      hashAlgorithm: HashAlgorithm.SHA2_256,
      publicKey: { rawBytes: ctlog.publicKey, keyDetails: PublicKeyDetails.PKIX_ECDSA_P256_SHA_256, validFor: { start } },
      logId: { keyId: Buffer.from(ctlog.logID.buffer) },
    }],
    timestampAuthorities: [],
  });
  return {
    trustedRoot: root,
    /** Keyless-sign `data` as identity `sub` from OIDC issuer `iss`; returns the bundle JSON. */
    async sign(data, { iss = 'https://issuer.speckl.test', sub = 'carol@example.com', tlog: withTlog = true } = {}) {
      const token = b64url({ alg: 'none' }) + '.' + b64url({ iss, sub, aud: 'sigstore', exp: Math.floor(Date.now() / 1000) + 600 }) + '.';
      const signer = new FulcioSigner({ fulcioBaseURL: FULCIO, identityProvider: { getToken: async () => token } });
      const witnesses = withTlog ? [new RekorWitness({ rekorBaseURL: REKOR })] : [];
      const bundle = await new MessageSignatureBundleBuilder({ signer, witnesses }).create({ data: Buffer.from(data) });
      return bundleToJSON(bundle);
    },
    close() { nock.cleanAll(); },
  };
}

/** Write a trusted root to dir; returns { path, sha256 }. */
export function writeRoot(dir, root) {
  const p = path.join(dir, 'trusted_root.json');
  const buf = Buffer.from(JSON.stringify(root, null, 2));
  fs.writeFileSync(p, buf);
  return { path: p, sha256: crypto.createHash('sha256').update(buf).digest('hex') };
}
