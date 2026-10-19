import assert from 'node:assert/strict';

// Share the same positive file policy before packaging and before extraction.
export function nodeReleaseFile(name) {
  return typeof name === 'string' && !/[\r\n]/.test(name)
    && /^(?:package\.json|package-lock\.json|ecosystem\.config\.cjs|release\.json|SHA256SUMS|dist\/(?:index\.html|server\.cjs(?:\.map)?|assets\/[\w-]+\.(?:js|css)|brand\/[\w-]+\.svg|fonts\/[\w-]+\.woff2))$/.test(name);
}

export function assertNodeServerSources(map) {
  assert.ok(Array.isArray(map.sources) && map.sources.length > 0, 'Server source map is required');
  for (const source of map.sources) {
    assert.ok(typeof source === 'string' && !/[\r\n]/.test(source)
      && (source === '../server.ts' || /^\.\.\/src\/(?:[\w-]+\/)*[\w-]+\.tsx?$/.test(source)),
      `Source outside the released Node application: ${source}`);
  }
}
