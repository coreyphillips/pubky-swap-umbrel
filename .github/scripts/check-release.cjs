'use strict';

const { createHash } = require('node:crypto');
const fs = require('node:fs');

const REPOSITORY = 'coreyphillips/pubky-swap-app';
const IMAGE = `ghcr.io/${REPOSITORY}`;
const INDEX_TYPES = new Set([
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
]);
const IMAGE_TYPES = new Set([
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
]);
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const REQUIRED_ARCHITECTURES = ['amd64', 'arm64'];

function parseRelease(compose, manifest) {
  const images = [...compose.matchAll(/^\s*image:\s*["']?(ghcr\.io\/coreyphillips\/pubky-swap-app:[^\s"'#]+)["']?\s*(?:#.*)?$/gm)];
  if (images.length !== 1) throw new Error('Compose must name exactly one Pubky Swap image.');
  const image = images[0][1];
  const match = /^ghcr\.io\/coreyphillips\/pubky-swap-app:([A-Za-z0-9_][A-Za-z0-9_.-]*)@(sha256:[0-9a-f]{64})$/.exec(image);
  if (!match) throw new Error('Pin the release image to a version tag and its complete sha256 digest.');
  const version = /^version:\s*["']([^"']+)["']\s*$/m.exec(manifest)?.[1];
  if (!version || match[1] !== version) {
    throw new Error(`Image tag ${match[1]} does not match app version ${version || '(missing)'}.`);
  }
  return { image, tag: match[1], digest: match[2] };
}

function verifyIndex(bytes, expectedDigest, label) {
  const actualDigest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  if (actualDigest !== expectedDigest) {
    throw new Error(`${label} resolves to ${actualDigest}, expected ${expectedDigest}.`);
  }
  const index = JSON.parse(bytes.toString('utf8'));
  if (index.schemaVersion !== 2 || !INDEX_TYPES.has(index.mediaType) || !Array.isArray(index.manifests)) {
    throw new Error(`${label} must be a multi-architecture image index.`);
  }
  const architectures = new Set();
  for (const descriptor of index.manifests) {
    if (descriptor.artifactType) continue;
    if (descriptor.annotations?.['vnd.docker.reference.type'] === 'attestation-manifest') continue;
    if (descriptor.platform?.os !== 'linux' || !IMAGE_TYPES.has(descriptor.mediaType)) continue;
    if (!SHA256.test(descriptor.digest) || !Number.isInteger(descriptor.size) || descriptor.size <= 0) continue;
    architectures.add(descriptor.platform.architecture);
  }
  const missing = REQUIRED_ARCHITECTURES.filter((architecture) => !architectures.has(architecture));
  if (missing.length) throw new Error(`${label} has no runnable image for ${missing.map((arch) => `linux/${arch}`).join(', ')}.`);
}

async function registryResponse(url, options, fetchImpl) {
  const response = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(30_000) });
  if (response.status !== 200) throw new Error(`Registry request failed with HTTP ${response.status}.`);
  return response;
}

async function checkPublishedRelease(release, fetchImpl = fetch) {
  const tokenUrl = `https://ghcr.io/token?scope=repository:${REPOSITORY}:pull&service=ghcr.io`;
  const tokenResponse = await registryResponse(tokenUrl, {}, fetchImpl);
  const credentials = await tokenResponse.json();
  const token = credentials.token || credentials.access_token;
  if (typeof token !== 'string' || !token) throw new Error('Registry did not issue an anonymous pull token.');
  const headers = { Authorization: `Bearer ${token}`, Accept: [...INDEX_TYPES, ...IMAGE_TYPES].join(', ') };
  for (const reference of [release.tag, release.digest]) {
    const response = await registryResponse(`https://ghcr.io/v2/${REPOSITORY}/manifests/${reference}`, { headers }, fetchImpl);
    const bytes = Buffer.from(await response.arrayBuffer());
    verifyIndex(bytes, release.digest, `${IMAGE}:${reference}`);
    const reportedDigest = response.headers.get('docker-content-digest');
    if (reportedDigest && reportedDigest !== release.digest) {
      throw new Error(`Registry digest header does not match ${release.digest}.`);
    }
  }
}

async function main() {
  const composePath = 'pubky-swap/docker-compose.yml';
  if (!fs.existsSync(composePath)) {
    console.log('No app directory is advertised. Nothing to check.');
    return;
  }
  const release = parseRelease(fs.readFileSync(composePath, 'utf8'), fs.readFileSync('pubky-swap/umbrel-app.yml', 'utf8'));
  await checkPublishedRelease(release);
  console.log(`OK: ${release.image} matches its tag and publishes runnable linux/amd64 and linux/arm64 images.`);
}

module.exports = { parseRelease, verifyIndex, checkPublishedRelease };

if (require.main === module) {
  main().catch((error) => {
    console.error(`Release validation failed: ${error.message}`);
    process.exitCode = 1;
  });
}
