import {
  MUSIC_PROVIDER_KEYS,
  MusicPlaybackError,
  type MusicProviderKey,
  type MusicProviderPolicy
} from "./models.js";

const SEARCH_PROVIDERS: readonly MusicProviderKey[] = Object.freeze([
  "youtubei",
  "soundcloud",
  "spotify",
  "apple_music"
]);

const PROVIDER_HOSTS: Readonly<Record<MusicProviderKey, readonly string[]>> =
  Object.freeze({
    youtubei: Object.freeze([
      "youtube.com",
      "www.youtube.com",
      "m.youtube.com",
      "music.youtube.com",
      "youtu.be"
    ]),
    soundcloud: Object.freeze([
      "soundcloud.com",
      "www.soundcloud.com",
      "on.soundcloud.com"
    ]),
    attachment: Object.freeze([]),
    vimeo: Object.freeze([
      "vimeo.com",
      "www.vimeo.com",
      "player.vimeo.com"
    ]),
    reverbnation: Object.freeze([
      "reverbnation.com",
      "www.reverbnation.com"
    ]),
    spotify: Object.freeze(["open.spotify.com"]),
    apple_music: Object.freeze(["music.apple.com"])
  });

export const isMusicProviderKey = (
  value: unknown
): value is MusicProviderKey =>
  typeof value === "string" &&
  (MUSIC_PROVIDER_KEYS as readonly string[]).includes(value);

const inferLocatorProvider = (
  locator: URL,
  allowedRawMediaHosts: ReadonlySet<string>
): MusicProviderKey => {
  const hostname = locator.hostname.toLowerCase();
  for (const provider of MUSIC_PROVIDER_KEYS) {
    if (
      provider !== "attachment" &&
      PROVIDER_HOSTS[provider].includes(hostname)
    ) {
      return provider;
    }
  }
  if (allowedRawMediaHosts.has(hostname)) return "attachment";
  throw new MusicPlaybackError(
    "MUSIC.MEDIA_SOURCE_NOT_ALLOWED",
    "The media locator host is not approved.",
    false
  );
};

const parseLocator = (query: string): URL | null => {
  if (
    query.startsWith("/") ||
    query.startsWith("./") ||
    query.startsWith("../") ||
    query.startsWith("\\") ||
    /^[a-zA-Z]:[\\/]/u.test(query) ||
    /^file:/iu.test(query)
  ) {
    throw new MusicPlaybackError(
      "MUSIC.MEDIA_SOURCE_NOT_ALLOWED",
      "Local media paths are not accepted.",
      false
    );
  }
  if (!/^[a-z][a-z0-9+.-]*:/iu.test(query)) return null;
  let locator: URL;
  try {
    locator = new URL(query);
  } catch {
    throw new MusicPlaybackError(
      "MUSIC.MEDIA_QUERY_INVALID",
      "The media locator is invalid.",
      false
    );
  }
  if (
    locator.protocol !== "https:" ||
    locator.username.length > 0 ||
    locator.password.length > 0 ||
    locator.port.length > 0
  ) {
    throw new MusicPlaybackError(
      "MUSIC.MEDIA_SOURCE_NOT_ALLOWED",
      "Only approved secure media locators are accepted.",
      false
    );
  }
  const normalized = locator.toString();
  if (normalized.length > 2_048) {
    throw new MusicPlaybackError(
      "MUSIC.MEDIA_QUERY_INVALID",
      "The normalized media locator is too long.",
      false
    );
  }
  return locator;
};

export const normalizeMusicProviderPolicies = (
  policies: readonly MusicProviderPolicy[]
): readonly MusicProviderPolicy[] => {
  if (
    !Array.isArray(policies) ||
    Object.getPrototypeOf(policies) !== Array.prototype ||
    policies.length < 1 ||
    policies.length > MUSIC_PROVIDER_KEYS.length
  ) {
    throw new MusicPlaybackError(
      "MUSIC.MEDIA_QUERY_INVALID",
      "The media provider policy is invalid.",
      false
    );
  }
  const providers = new Set<MusicProviderKey>();
  const priorities = new Set<number>();
  const validated: MusicProviderPolicy[] = [];
  for (let index = 0; index < policies.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(
      policies,
      String(index)
    );
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new MusicPlaybackError(
        "MUSIC.MEDIA_QUERY_INVALID",
        "The media provider policy must be a dense data array.",
        false
      );
    }
    const policy = descriptor.value as MusicProviderPolicy;
    if (
      policy === null ||
      typeof policy !== "object" ||
      !isMusicProviderKey(policy.provider) ||
      typeof policy.enabled !== "boolean" ||
      !Number.isSafeInteger(policy.priority) ||
      policy.priority < 0 ||
      providers.has(policy.provider) ||
      priorities.has(policy.priority)
    ) {
      throw new MusicPlaybackError(
        "MUSIC.MEDIA_QUERY_INVALID",
        "The media provider policy is invalid or ambiguous.",
        false
      );
    }
    providers.add(policy.provider);
    priorities.add(policy.priority);
    validated.push(
      Object.freeze({
        provider: policy.provider,
        enabled: policy.enabled,
        priority: policy.priority
      })
    );
  }
  return Object.freeze(validated);
};

export type MusicProviderSelection = Readonly<{
  provider: MusicProviderKey;
  normalizedQuery: string;
}>;

export const selectMusicProvider = (input: {
  readonly query: string;
  readonly preferredProvider?: MusicProviderKey;
  readonly providerPolicies: readonly MusicProviderPolicy[];
  readonly readyProviders: ReadonlySet<MusicProviderKey>;
  readonly allowedRawMediaHosts: ReadonlySet<string>;
  readonly maximumQueryLength: number;
}): MusicProviderSelection => {
  if (
    typeof input.query !== "string" ||
    !Number.isSafeInteger(input.maximumQueryLength) ||
    input.maximumQueryLength < 1 ||
    input.maximumQueryLength > 2_000
  ) {
    throw new MusicPlaybackError(
      "MUSIC.MEDIA_QUERY_INVALID",
      "The media query boundary is invalid.",
      false
    );
  }
  if (input.query.length > input.maximumQueryLength * 4) {
    throw new MusicPlaybackError(
      "MUSIC.MEDIA_QUERY_INVALID",
      "The media query exceeds the raw input boundary.",
      false
    );
  }
  const query = input.query.trim();
  if (
    query.length === 0 ||
    [...query].length > input.maximumQueryLength ||
    /[\u0000-\u001f\u007f]/u.test(query)
  ) {
    throw new MusicPlaybackError(
      "MUSIC.MEDIA_QUERY_INVALID",
      `The media query must contain between 1 and ${input.maximumQueryLength} visible characters.`,
      false
    );
  }
  if (
    input.preferredProvider !== undefined &&
    !isMusicProviderKey(input.preferredProvider)
  ) {
    throw new MusicPlaybackError(
      "MUSIC.MEDIA_QUERY_INVALID",
      "The preferred media provider is invalid.",
      false
    );
  }
  const policies = normalizeMusicProviderPolicies(
    input.providerPolicies
  );
  const enabled = new Set(
    policies.filter((policy) => policy.enabled).map((policy) => policy.provider)
  );
  const requireAvailable = (provider: MusicProviderKey): void => {
    if (!enabled.has(provider)) {
      throw new MusicPlaybackError(
        "MUSIC.PROVIDER_DISABLED",
        `The selected media provider ${provider} is disabled.`,
        false
      );
    }
    if (!input.readyProviders.has(provider)) {
      throw new MusicPlaybackError(
        "MUSIC.PROVIDER_UNAVAILABLE",
        `The selected media provider ${provider} is unavailable.`,
        true
      );
    }
  };

  const locator = parseLocator(query);
  if (locator !== null) {
    const inferred = inferLocatorProvider(
      locator,
      input.allowedRawMediaHosts
    );
    if (
      input.preferredProvider !== undefined &&
      input.preferredProvider !== inferred
    ) {
      throw new MusicPlaybackError(
        "MUSIC.MEDIA_SOURCE_NOT_ALLOWED",
        "The media locator does not match the selected provider.",
        false
      );
    }
    requireAvailable(inferred);
    return Object.freeze({
      provider: inferred,
      normalizedQuery: locator.toString()
    });
  }

  if (input.preferredProvider !== undefined) {
    if (!SEARCH_PROVIDERS.includes(input.preferredProvider)) {
      throw new MusicPlaybackError(
        "MUSIC.MEDIA_QUERY_INVALID",
        "The selected provider accepts locators but not text searches.",
        false
      );
    }
    requireAvailable(input.preferredProvider);
    return Object.freeze({
      provider: input.preferredProvider,
      normalizedQuery: query
    });
  }

  const selected = [...policies]
    .filter(
      (policy) =>
        policy.enabled &&
        SEARCH_PROVIDERS.includes(policy.provider) &&
        input.readyProviders.has(policy.provider)
    )
    .sort((left, right) => left.priority - right.priority)[0]?.provider;
  if (selected === undefined) {
    throw new MusicPlaybackError(
      "MUSIC.PROVIDER_UNAVAILABLE",
      "No enabled search provider is currently available.",
      true
    );
  }
  return Object.freeze({ provider: selected, normalizedQuery: query });
};

export const approvedMusicProviderHosts = (
  provider: MusicProviderKey
): readonly string[] => PROVIDER_HOSTS[provider];
