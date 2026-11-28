import { z } from 'zod';
import {
  FactoryError,
  type FactoryAsset,
  type FactoryFile,
  type FactoryProject,
  type FactoryReference,
} from './game-factory-contracts.js';

const text = (max: number) => z.string().trim().min(1).max(max);
export const factoryReferenceSchema = z
  .object({
    // This is a citation, not a fetch target. Never resolve or request this URL.
    sourceUrl: text(2048)
      .url()
      .refine((value) => {
        try {
          const url = new URL(value);
          return (
            ['http:', 'https:'].includes(url.protocol) &&
            !url.username &&
            !url.password
          );
        } catch {
          return false;
        }
      }),
    sourceRevision: text(160),
    summary: text(600),
    materialType: z.enum(['prompt', 'code', 'document', 'asset_example']),
    sourceEngine: z.enum([
      'canvas',
      'phaser',
      'threejs',
      'godot',
      'unity',
      'unreal',
      'other',
    ]),
    rightsBasis: z.enum(['owner_reported', 'unverified']),
    rightsEvidence: text(800),
  })
  .strict();

/** Do not silently normalize traversal or aliases into an existing record. */
export function validateFactoryReferencePath(relativePath: string): void {
  if (
    relativePath.includes('\\') ||
    /[\u0000-\u001f\u007f]/u.test(relativePath) ||
    relativePath
      .split('/')
      .some((part) => !part || part === '.' || part === '..') ||
    /^[a-z]:/iu.test(relativePath)
  )
    throw new FactoryError('invalid_reference_path');
}

/** Return the immutable existing record, or require a separate source/version.
 * A retry under a new operation ID may still advance project.revision, but it
 * must not create a second asset or overwrite the original source attribution. */
export function existingFactoryReference(
  project: FactoryProject,
  input: {
    relativePath: string;
    provenance: string;
    rights: string;
    reference: FactoryReference;
  },
  file: FactoryFile,
): FactoryAsset | undefined {
  const matches = project.assets.filter(
    (asset) =>
      asset.relativePath === input.relativePath ||
      (asset.reference?.sourceUrl === input.reference.sourceUrl &&
        asset.reference.sourceRevision === input.reference.sourceRevision &&
        asset.file.sha256 === file.sha256),
  );
  for (const asset of matches) {
    if (
      !asset.reference ||
      asset.file.sha256 !== file.sha256 ||
      asset.file.size !== file.size ||
      asset.provenance !== input.provenance ||
      asset.rights !== input.rights ||
      (Object.keys(input.reference) as Array<keyof FactoryReference>).some(
        (key) => asset.reference![key] !== input.reference[key],
      )
    )
      throw new FactoryError('reference_conflict');
  }
  return matches[0];
}

export function factoryReferenceContext(
  project: FactoryProject,
  referenceIds?: string[],
) {
  const available = project.assets.filter(
    (asset) => asset.reference && asset.state === 'candidate',
  );
  const selected =
    referenceIds === undefined
      ? available.slice(-3)
      : referenceIds.map((id) => {
          const asset = available.find((item) => item.id === id);
          if (!asset) throw new FactoryError('reference_unavailable');
          return asset;
        });
  const candidates = selected.map((asset) => ({
    assetId: asset.id,
    relativePath: asset.relativePath,
    sha256: asset.file.sha256,
    bytes: asset.file.size,
    ...asset.reference!,
    source: { at: asset.source.at, trust: asset.source.trust },
  }));
  // Character limits alone do not bound UTF-8 IPC size. Keep full citations
  // intact; oversized records remain available through paginated inspect.
  let remainingBytes = 12 * 1024 - 2;
  const items = candidates.filter((item) => {
    const bytes = Buffer.byteLength(JSON.stringify(item)) + 1;
    if (bytes > remainingBytes) return false;
    remainingBytes -= bytes;
    return true;
  });
  return {
    trust: 'untrusted_reference_data' as const,
    authority: 'none' as const,
    quality: 'not_evaluated' as const,
    fileAssurance: 'hash_at_registration' as const,
    contentIncluded: false,
    selection: referenceIds === undefined ? 'latest' : 'explicit',
    items,
    total: available.length,
    complete: items.length === available.length,
    omittedForSize: selected.length - items.length,
    detailAction: 'inspect' as const,
    detailSection: 'assets' as const,
  };
}
