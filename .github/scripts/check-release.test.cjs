'use strict';

const { createHash } = require('node:crypto');
const assert = require('node:assert/strict');
const test = require('node:test');
const { parseRelease, verifyIndex, checkPublishedRelease } = require('./check-release.cjs');

const OCI_INDEX = 'application/vnd.oci.image.index.v1+json';
const OCI_IMAGE = 'application/vnd.oci.image.manifest.v1+json';
const DOCKER_INDEX = 'application/vnd.docker.distribution.manifest.list.v2+json';
const DOCKER_IMAGE = 'application/vnd.docker.distribution.manifest.v2+json';
const image = (architecture, extra = {}) => ({
  mediaType: OCI_IMAGE, size: 100, digest: `sha256:${'a'.repeat(64)}`,
  platform: { os: 'linux', architecture }, ...extra,
});
function fixture(manifests, mediaType = OCI_INDEX) {
  const bytes = Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType, manifests }));
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  return { bytes, digest, tag: '0.2.5' };
}

test('requires a pinned image with the same app and image version', () => {
  const { digest } = fixture([image('amd64'), image('arm64')]);
  const reference = `ghcr.io/coreyphillips/pubky-swap-app:0.2.5@${digest}`;
  assert.deepEqual(parseRelease(`    image: ${reference}\n`, 'version: "0.2.5"\n'), {
    image: reference, tag: '0.2.5', digest,
  });
  assert.throws(() => parseRelease(`image: ${reference}`, 'version: "0.2.4"'), /does not match/);
  assert.throws(() => parseRelease('image: ghcr.io/coreyphillips/pubky-swap-app:0.2.5', 'version: "0.2.5"'), /complete sha256/);
  assert.throws(() => parseRelease(`image: ${reference}\nimage: ${reference}`, 'version: "0.2.5"'), /exactly one/);
});

test('accepts OCI and Docker indexes with both architectures and optional attestations', () => {
  for (const [indexType, imageType] of [[OCI_INDEX, OCI_IMAGE], [DOCKER_INDEX, DOCKER_IMAGE]]) {
    const { bytes, digest } = fixture([
      image('amd64', { mediaType: imageType }), image('arm64', { mediaType: imageType }),
      image('unknown', { platform: { os: 'unknown', architecture: 'unknown' }, annotations: { 'vnd.docker.reference.type': 'attestation-manifest' } }),
    ], indexType);
    assert.doesNotThrow(() => verifyIndex(bytes, digest, 'fixture'));
  }
});

test('rejects a different manifest even when its registry digest exists', () => {
  const published = fixture([image('amd64'), image('arm64')]);
  const different = fixture([image('arm64'), image('amd64')]);
  assert.throws(() => verifyIndex(published.bytes, different.digest, 'tag'), /resolves to/);
});

test('requires runnable images, not attestations or nested indexes', () => {
  for (const arm64 of [
    image('arm64', { annotations: { 'vnd.docker.reference.type': 'attestation-manifest' } }),
    image('arm64', { artifactType: 'application/vnd.in-toto+json' }),
    image('arm64', { mediaType: OCI_INDEX }),
    image('arm64', { platform: { os: 'unknown', architecture: 'arm64' } }),
    image('arm64', { digest: 'sha256:invalid' }),
  ]) {
    const { bytes, digest } = fixture([image('amd64'), arm64]);
    assert.throws(() => verifyIndex(bytes, digest, 'fixture'), /no runnable image for linux\/arm64/);
  }
});

test('rejects either missing architecture and a single-platform manifest', () => {
  for (const architecture of ['amd64', 'arm64']) {
    const { bytes, digest } = fixture([image(architecture)]);
    assert.throws(() => verifyIndex(bytes, digest, 'fixture'), /no runnable image/);
  }
  const { bytes, digest } = fixture([image('amd64'), image('arm64')], OCI_IMAGE);
  assert.throws(() => verifyIndex(bytes, digest, 'fixture'), /multi-architecture image index/);
});

function registry(release, { tagBytes = release.bytes, digestStatus = 200, header = release.digest } = {}) {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push(url);
    if (url.startsWith('https://ghcr.io/token?')) return new Response('{"token":"fixture-token"}');
    assert.equal(options.headers.Authorization, 'Bearer fixture-token');
    assert.match(options.headers.Accept, /application\/vnd.oci.image.index/);
    const byDigest = url.endsWith(release.digest);
    return new Response(byDigest ? release.bytes : tagBytes, {
      status: byDigest ? digestStatus : 200,
      headers: { 'docker-content-digest': header },
    });
  };
  return { fetchImpl, requests };
}

test('reads and verifies both the tag and digest using only anonymous registry requests', async () => {
  const release = fixture([image('amd64'), image('arm64')]);
  const fake = registry(release);
  await checkPublishedRelease(release, fake.fetchImpl);
  assert.equal(fake.requests.length, 3);
  assert.ok(fake.requests[1].endsWith('/0.2.5'));
  assert.ok(fake.requests[2].endsWith(`/${release.digest}`));
});

test('rejects stale tags, missing digest publications and inconsistent registry headers', async () => {
  const release = fixture([image('amd64'), image('arm64')]);
  const stale = fixture([image('arm64'), image('amd64')]);
  await assert.rejects(checkPublishedRelease(release, registry(release, { tagBytes: stale.bytes }).fetchImpl), /resolves to/);
  await assert.rejects(checkPublishedRelease(release, registry(release, { digestStatus: 404 }).fetchImpl), /HTTP 404/);
  await assert.rejects(checkPublishedRelease(release, registry(release, { header: stale.digest }).fetchImpl), /digest header/);
});
