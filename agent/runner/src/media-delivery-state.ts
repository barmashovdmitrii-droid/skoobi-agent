type RecordValue = Record<string, unknown>;
const object = (v: unknown): v is RecordValue =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const uuid = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(v);
const part = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 8;
export function confirmedMediaReceipt(value: unknown): boolean {
  if (!object(value) || value.state !== 'delivered') return false;
  if (Array.isArray(value.receipts))
    return (
      value.receipts.length > 0 && value.receipts.every(confirmedMediaReceipt)
    );
  return (
    uuid(value.deliveryId) &&
    typeof value.acknowledgedAt === 'string' &&
    Number.isFinite(Date.parse(value.acknowledgedAt))
  );
}
interface Delivery {
  state: string;
  hash?: string;
  voice?: { assetId: string; part: number };
}
interface Asset {
  requested: boolean;
  expected?: Set<number>;
}
/** A turn-local reducer. Only exact receipts settle their own requests. */
export function createMediaDeliveryState() {
  const deliveries = new Map<string, Delivery>(),
    assets = new Map<string, Asset>(),
    other = new Set<string>();
  const asset = (id: string) => {
    let a = assets.get(id);
    if (!a) {
      a = { requested: false };
      assets.set(id, a);
    }
    return a;
  };
  const setExpected = (id: string, parts: unknown) => {
    if (
      !Array.isArray(parts) ||
      !parts.length ||
      parts.length > 8 ||
      !parts.every(part)
    )
      return;
    const sorted = [...new Set(parts)].sort((a, b) => a - b);
    if (sorted.some((p, i) => p !== i + 1)) return;
    const current = asset(id);
    // Conflicting metadata cannot shrink the obligation and hide a missing part.
    if (
      current.expected &&
      [...current.expected].some((p) => !sorted.includes(p))
    )
      return;
    current.expected = new Set(sorted);
  };
  const observe = (
    value: unknown,
    context: { fallback?: string; aggregateVoice?: boolean } = {},
  ) => {
    if (!object(value)) return;
    const state = String(value.state),
      assetId = uuid(value.assetId) ? value.assetId : undefined;
    if (assetId) {
      if (context.aggregateVoice || state === 'delivery_incomplete')
        asset(assetId).requested = true;
      setExpected(assetId, value.expectedParts);
      if (state === 'ready' && Array.isArray(value.files))
        setExpected(
          assetId,
          value.files
            .filter((f) => object(f) && f.format === 'ogg')
            .map((f) => (f as RecordValue).part),
        );
    }
    if (uuid(value.deliveryId)) {
      const key = value.deliveryId,
        prior = deliveries.get(key);
      const entry: Delivery = {
        state: confirmedMediaReceipt(value)
          ? 'delivered'
          : state === 'delivered'
            ? 'unknown'
            : state,
        ...(prior?.voice ? { voice: prior.voice } : {}),
      };
      if (
        object(value.artifact) &&
        typeof value.artifact.sha256 === 'string' &&
        /^[a-f0-9]{64}$/.test(value.artifact.sha256)
      )
        entry.hash = value.artifact.sha256;
      else if (prior?.hash) entry.hash = prior.hash;
      const binding = object(value.voiceAsset)
        ? value.voiceAsset
        : object(value.requestedVoice)
          ? value.requestedVoice
          : undefined;
      if (binding && uuid(binding.assetId) && part(binding.part)) {
        const current = { assetId: binding.assetId, part: binding.part };
        if (
          !prior?.voice ||
          (prior.voice.assetId === current.assetId &&
            prior.voice.part === current.part)
        )
          entry.voice = current;
        if (
          binding === value.voiceAsset &&
          part(binding.totalParts) &&
          binding.part <= binding.totalParts
        )
          setExpected(
            binding.assetId,
            Array.from({ length: binding.totalParts }, (_, i) => i + 1),
          );
      }
      // A late pending snapshot cannot erase an already recorded channel ACK.
      if (prior?.state !== 'delivered') deliveries.set(key, entry);
    } else if (!assetId && context.fallback) {
      if (confirmedMediaReceipt(value)) other.delete(context.fallback);
      else if (
        [
          'checking',
          'sending',
          'generating',
          'unknown',
          'blocked',
          'delivery_incomplete',
          'expired',
        ].includes(state)
      )
        other.add(context.fallback);
    }
    if (Array.isArray(value.receipts))
      for (const child of value.receipts) observe(child);
  };
  const hasUnresolved = () => {
    const confirmedHashes = new Set<string>(),
      confirmedParts = new Set<string>();
    for (const d of deliveries.values())
      if (d.state === 'delivered') {
        if (d.hash) confirmedHashes.add(d.hash);
        if (d.voice) confirmedParts.add(`${d.voice.assetId}:${d.voice.part}`);
      }
    for (const d of deliveries.values())
      if (d.state !== 'delivered') {
        if (
          d.state === 'blocked' &&
          ((d.hash && confirmedHashes.has(d.hash)) ||
            (d.voice &&
              confirmedParts.has(`${d.voice.assetId}:${d.voice.part}`)))
        )
          continue;
        return true;
      }
    for (const [id, a] of assets)
      if (
        a.requested &&
        (!a.expected ||
          ![...a.expected].every((p) => confirmedParts.has(`${id}:${p}`)))
      )
        return true;
    return other.size > 0;
  };
  return { observe, hasUnresolved };
}
