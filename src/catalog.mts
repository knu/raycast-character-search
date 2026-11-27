export type Filter = "all" | "unicode" | "emoji" | "nerd";

type EmojiMetadata = [shortcodes: string[], keywords: string[]];

export type CatalogData = {
  names: [range: string, name: string][];
  aliases: [hex: string, name: string, type: string][];
  blocks?: [range: string, name: string][];
  emoji: [hexSequence: string, name: string][];
  emojiMetadata?: Record<string, EmojiMetadata>;
  nerd: [hex: string, name: string][];
  previewId: string;
};

type Kind = Exclude<Filter, "all">;
export type Entry = {
  character: string;
  name: string;
  codes: string[];
  kind: Kind;
};

type ControlPreview = { symbol: string } | { label: string };

type SearchResults = {
  total: number;
  page(offset: number, size: number): Entry[];
  paginate(
    size: number,
    nerdShare?: number,
  ): {
    count: number;
    offset(page: number): number;
    entries(page: number): Entry[];
  };
};

// Match lists hold catalog references, so even a broad search builds only
// the entry objects needed for the current page.
const emojiOffset = 0x110000;
const exampleCharacters = [
  "→",
  "✓",
  "—",
  "∞",
  "©",
  "😀",
  "👍",
  "❤️",
  "👩‍💻",
  "🇯🇵",
];
const exampleGlyphNames = ["nf-fa-github", "nf-fa-terminal"];

const nerdGroupNames = new Map([
  ["cod", "codicons"],
  ["custom", "seti ui custom"],
  ["dev", "devicons"],
  ["extra", "progress indicators"],
  ["fa", "font awesome"],
  ["fae", "font awesome extension"],
  ["iec", "iec power symbols"],
  ["indent", "indentation guides"],
  ["indentation", "indentation guides"],
  ["linux", "font logos"],
  ["md", "material design icons"],
  ["oct", "octicons"],
  ["pl", "powerline symbols"],
  ["ple", "powerline extra symbols"],
  ["pom", "pomicons"],
  ["seti", "seti ui custom"],
  ["weather", "weather icons"],
]);

function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function hasWordPrefix(term: string, prefix: string): boolean {
  return term.startsWith(prefix) || term.includes(` ${prefix}`);
}

function hasSubword(term: string, word: string): boolean {
  return word.length > 1 ? term.includes(word) : hasWordPrefix(term, word);
}

function hexOf(point: number): string {
  return point.toString(16).toUpperCase().padStart(4, "0");
}

function hexSequence(character: string): string {
  return Array.from(character, (glyph) => hexOf(glyph.codePointAt(0)!)).join(
    " ",
  );
}

function makeEntry(sequence: string, name: string, kind: Kind): Entry {
  const codes = sequence.split(" ");
  return {
    character: String.fromCodePoint(
      ...codes.map((code) => Number.parseInt(code, 16)),
    ),
    name,
    codes,
    kind,
  };
}

function parseCodeQuery(
  query: string,
): { sequence: string; priority: boolean } | undefined {
  const tokens = query.split(/\s+/);
  if (tokens.length > 32) return;
  const codes = [];
  let priority = false;
  for (const token of tokens) {
    const explicit =
      /^(?:(?:U\+|0x)([\da-f]{1,6})|\\u\{([\da-f]{1,6})\})$/i.exec(token);
    if (!explicit && !/^[\da-f]{4,6}$/i.test(token)) return;
    const point = Number.parseInt(explicit?.[1] ?? explicit?.[2] ?? token, 16);
    if (point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) return;
    priority ||= Boolean(explicit) || /\d/.test(token);
    codes.push(hexOf(point));
  }
  return { sequence: codes.join(" "), priority };
}

function matchesFilter(kind: Kind, sequence: string, filter: Filter): boolean {
  return (
    filter === "all" ||
    kind === filter ||
    (filter === "unicode" && kind === "emoji" && !sequence.includes(" "))
  );
}

export function formatCodePoints(entry: Entry): string {
  return entry.codes.map((code) => `U+${code}`).join(" ");
}

export function createCatalog(data: CatalogData) {
  // DerivedName is ordered by code point. Preserve its algorithmic ranges in memory.
  const starts = Uint32Array.from(data.names, ([range]) =>
    Number.parseInt(range, 16),
  );
  const blocks = (data.blocks ?? []).map(([range, name]) => {
    const [start, end] = range.split("..");
    return {
      start: Number.parseInt(start, 16),
      end: Number.parseInt(end, 16),
      term: normalizeName(name),
    };
  });
  function blockIndexAt(point: number) {
    let first = 0;
    let end = blocks.length;
    while (first < end) {
      const middle = (first + end) >>> 1;
      if (blocks[middle].start <= point) first = middle + 1;
      else end = middle;
    }
    return first - 1;
  }
  const aliases = new Map<string, string[]>();
  const abbreviations = new Map<string, string>();
  for (const [code, name, type] of data.aliases) {
    const existing = aliases.get(code);
    if (existing) existing.push(name);
    else aliases.set(code, [name]);
    if (type === "abbreviation" && !abbreviations.has(code))
      abbreviations.set(code, name);
  }
  const nerdOffset = emojiOffset + data.emoji.length;
  const emojiIndices = new Map(
    data.emoji.map(([sequence], index) => [sequence, index]),
  );
  const variationSequences = new Map<string, string>();
  for (const [sequence] of data.emoji) {
    const unqualified = sequence.replaceAll(" FE0F", "");
    if (unqualified !== sequence) variationSequences.set(unqualified, sequence);
  }

  function unicodeName(code: string) {
    const point = Number.parseInt(code, 16);
    let first = 0;
    let end = starts.length;
    while (first < end) {
      const middle = (first + end) >>> 1;
      if (starts[middle] <= point) first = middle + 1;
      else end = middle;
    }
    if (first === 0) return;
    const [range, name] = data.names[first - 1];
    const boundary = range.indexOf("..");
    if (
      range === code ||
      (boundary !== -1 &&
        point <= Number.parseInt(range.slice(boundary + 2), 16))
    ) {
      return name.replace("*", code);
    }
  }

  const emojiSearchTerms = data.emoji.map(([sequence]) => {
    const [shortcodes, keywords] = data.emojiMetadata?.[sequence] ?? [[], []];
    return normalizeName([...shortcodes, ...keywords].join(" "));
  });
  const shortcodeMatches = new Map<string, number>();
  const emojiOrder = new Map<number, number>();
  data.emoji.forEach(([sequence], index) => {
    const entryIndex =
      !sequence.includes(" ") &&
      (unicodeName(sequence) || aliases.has(sequence))
        ? Number.parseInt(sequence, 16)
        : emojiOffset + index;
    // emoji-test.txt follows the CLDR order used by the chart's No. column.
    emojiOrder.set(entryIndex, index);
    for (const name of data.emojiMetadata?.[sequence]?.[0] ?? [])
      shortcodeMatches.set(name, entryIndex);
  });

  function emojiInfo(entry: Entry): EmojiMetadata | undefined {
    if (entry.kind === "emoji")
      return data.emojiMetadata?.[entry.codes.join(" ")];
  }

  function lookup(sequence: string, filter: Filter): number[] {
    if (!sequence) return [];
    const results: number[] = [];
    const emojiIndex = emojiIndices.get(sequence);
    const single = !sequence.includes(" ");
    if (
      matchesFilter(
        emojiIndex === undefined ? "unicode" : "emoji",
        sequence,
        filter,
      )
    ) {
      if (single && (unicodeName(sequence) || aliases.has(sequence))) {
        results.push(Number.parseInt(sequence, 16));
      } else if (emojiIndex !== undefined) {
        results.push(emojiOffset + emojiIndex);
      }
    }
    if (single && (filter === "all" || filter === "nerd")) {
      data.nerd.forEach(([hex], index) => {
        if (sequence === hex) results.push(nerdOffset + index);
      });
    }
    return results;
  }

  function resolveEntry(index: number): Entry {
    if (index >= nerdOffset)
      return makeEntry(...data.nerd[index - nerdOffset], "nerd");
    if (index >= emojiOffset)
      return makeEntry(...data.emoji[index - emojiOffset], "emoji");
    const code = hexOf(index);
    const name = unicodeName(code) ?? aliases.get(code)![0];
    return makeEntry(code, name, emojiIndices.has(code) ? "emoji" : "unicode");
  }

  function orderEmoji(matches: number[]) {
    const emojiPositions: number[] = [];
    const emojiMatches: number[] = [];
    for (let i = 0; i < matches.length; i++) {
      const id = matches[i];
      if (emojiOrder.has(id)) {
        emojiPositions.push(i);
        emojiMatches.push(id);
      }
    }
    emojiMatches.sort((a, b) => emojiOrder.get(a)! - emojiOrder.get(b)!);
    // Preserve the positions and order of non-emoji results.
    for (const [i, position] of emojiPositions.entries())
      matches[position] = emojiMatches[i];
    return matches;
  }

  function list(matches: number[]): SearchResults {
    function page(offset: number, size: number) {
      return matches.slice(offset, offset + size).map(resolveEntry);
    }
    return {
      total: matches.length,
      page,
      paginate(size, nerdShare) {
        const count = Math.ceil(matches.length / size);
        const offset = (index: number) =>
          Math.min(index * size, matches.length);
        if (nerdShare === undefined) {
          return {
            count,
            offset,
            entries: (index) => page(index * size, size),
          };
        }

        const unicode: number[] = [];
        const nerd: number[] = [];
        for (const id of matches) {
          (id >= nerdOffset ? nerd : unicode).push(id);
        }
        // Once either group runs out, the other takes its unused slots.
        const nerdOffsetAt = (index: number) =>
          Math.min(
            Math.max(index * nerdShare, offset(index) - unicode.length),
            nerd.length,
          );
        const unicodeOffsetAt = (index: number) =>
          offset(index) - nerdOffsetAt(index);
        return {
          count,
          offset,
          entries: (index) =>
            [
              ...unicode.slice(
                unicodeOffsetAt(index),
                unicodeOffsetAt(index + 1),
              ),
              ...nerd.slice(nerdOffsetAt(index), nerdOffsetAt(index + 1)),
            ].map(resolveEntry),
        };
      },
    };
  }

  const suggested = [
    ...exampleCharacters.flatMap((character) =>
      lookup(hexSequence(character), "all").slice(0, 1),
    ),
    ...data.nerd.flatMap(([, name], index) =>
      exampleGlyphNames.includes(name) ? [nerdOffset + index] : [],
    ),
  ];

  function search(rawQuery: string, filter: Filter = "all"): SearchResults {
    const query = rawQuery.trim();
    if (!rawQuery) {
      return list(
        orderEmoji(
          suggested.filter((index) => {
            const entry = resolveEntry(index);
            return matchesFilter(entry.kind, entry.codes.join(" "), filter);
          }),
        ),
      );
    }

    const shortcodeQuery = /^:([a-z0-9_+-]+)(:?)$/i.exec(query);
    const shortcode = (shortcodeQuery?.[1] ?? query).toLowerCase();
    const shortcodeMatch = shortcodeMatches.get(shortcode);
    const acceptsShortcode = filter !== "nerd";
    if (shortcodeQuery && shortcodeMatches.size > 0) {
      if (!acceptsShortcode) return list([]);
      const prefixes = new Set<number>();
      if (!shortcodeQuery[2]) {
        for (const [name, index] of shortcodeMatches)
          if (index !== shortcodeMatch && name.startsWith(shortcode))
            prefixes.add(index);
      }
      const allowed = (index: number) =>
        filter !== "unicode" || index < emojiOffset;
      const exact =
        shortcodeMatch !== undefined && allowed(shortcodeMatch)
          ? [shortcodeMatch]
          : [];
      return list(
        exact.concat(orderEmoji([...prefixes].filter(allowed))),
      );
    }

    const literalSequence = rawQuery.length <= 64 ? hexSequence(rawQuery) : "";
    const trimmedSequence =
      query === rawQuery || query.length > 64
        ? literalSequence
        : hexSequence(query);
    const literal = lookup(literalSequence, filter);
    const primary =
      literal.length > 0 || trimmedSequence === literalSequence
        ? literal
        : lookup(trimmedSequence, filter);
    const codeQuery = parseCodeQuery(query);
    const codeMatches = codeQuery ? lookup(codeQuery.sequence, filter) : [];
    const qualified = variationSequences.get(trimmedSequence);
    if (qualified) primary.push(...lookup(qualified, filter));
    if (codeQuery?.priority) primary.push(...codeMatches);
    if (
      acceptsShortcode &&
      shortcodeMatch !== undefined &&
      (filter !== "unicode" || shortcodeMatch < emojiOffset)
    )
      primary.push(shortcodeMatch);

    const exactMatches = [...new Set(primary)];
    if (codeQuery?.priority || /^(?:u\+|0x|\\u\{)/i.test(query))
      return list(exactMatches);

    const nameQuery = normalizeName(query);
    if (!nameQuery) return list(exactMatches);
    const words = nameQuery.split(" ");
    // Category prefixes qualify emoji without weakening a name match.
    const emojiNameQuery =
      words
        .filter((word) => word.length === 1 || !"emoji".startsWith(word))
        .join(" ") || nameQuery;
    const exactBlock = blocks.find((block) => block.term === nameQuery);
    const metadataPenalty = 2;
    const buckets = Array.from({ length: 6 + metadataPenalty }, () => ({
      unicode: [] as number[],
      nerd: [] as number[],
    }));

    function rank(term: string, exactRank = 0, extra = "", phrase = nameQuery) {
      if (term === phrase) return exactRank;
      if (` ${term} `.includes(` ${phrase} `)) return 2;
      if (hasWordPrefix(term, phrase)) return 3;
      if (
        words.every(
          (word) => hasWordPrefix(term, word) || hasWordPrefix(extra, word),
        )
      )
        return 4;
      return words.every(
        (word) => hasSubword(term, word) || hasSubword(extra, word),
      )
        ? 5
        : Infinity;
    }

    function rankEmoji(
      index: number,
      name?: string,
      otherNames: string[] = [],
      block = "",
    ) {
      const shortName = normalizeName(data.emoji[index][1]);
      const names = [shortName, ...otherNames.map(normalizeName)];
      if (name !== undefined) names.unshift(normalizeName(name));
      const primaryNames = name === undefined ? 1 : 2;
      const score = Math.min(
        ...names.map((term, position) =>
          rank(term, position < primaryNames ? 0 : 1, "emoji", emojiNameQuery),
        ),
      );
      if (score < 5) return score;
      return Math.min(
        score,
        // Matches that require emoji tags, shortcodes, or block names rank
        // after matches in the names themselves.
        metadataPenalty +
          rank(
            "",
            0,
            `emoji ${names.join(" ")} ${emojiSearchTerms[index]} ${block}`,
          ),
      );
    }

    function add(index: number, score: number) {
      if (score < buckets.length)
        buckets[score][index >= nerdOffset ? "nerd" : "unicode"].push(index);
    }

    function blockTermAt(point: number, index = blockIndexAt(point)) {
      const block = blocks[index];
      return block &&
        point <= block.end &&
        (!exactBlock || block === exactBlock)
        ? block.term
        : "";
    }

    function rankRange(start: number, end: number, stem: string) {
      // One DerivedName range can span several Unicode blocks.
      let blockIndex = blockIndexAt(start);
      while (start <= end) {
        const block = blocks[blockIndex];
        const inBlock = block && start <= block.end;
        const term = blockTermAt(start, blockIndex);
        const nextBlock = blocks[blockIndex + 1]?.start ?? end + 1;
        const last = Math.min(end, inBlock ? block.end : nextBlock - 1);
        const missing = words.filter(
          (word) => !hasSubword(stem, word) && !hasSubword(term, word),
        );
        if (missing.every((word) => /^[\da-f]{1,6}$/.test(word))) {
          for (let point = start; point <= last; point++) {
            const hex = hexOf(point).toLowerCase();
            if (missing.every((word) => hasSubword(hex, word)))
              add(point, rank(`${stem} ${hex}`, 0, term));
          }
        }
        start = last + 1;
        if (start >= nextBlock) blockIndex++;
      }
    }

    if (filter === "all" || filter === "unicode") {
      for (let index = 0; index < data.names.length; index++) {
        const [range, name] = data.names[index];
        const boundary = range.indexOf("..");
        if (boundary === -1) {
          const block = blockTermAt(starts[index]);
          const emojiIndex = emojiIndices.get(range);
          const otherNames = aliases.get(range);
          if (emojiIndex !== undefined) {
            add(starts[index], rankEmoji(emojiIndex, name, otherNames, block));
          } else {
            let score = rank(normalizeName(name), 0, block);
            for (const alias of otherNames ?? [])
              score = Math.min(score, rank(normalizeName(alias), 1, block));
            add(starts[index], score);
          }
          continue;
        }

        rankRange(
          starts[index],
          Number.parseInt(range.slice(boundary + 2), 16),
          normalizeName(name),
        );
      }

      for (const [code, [name, ...otherNames]] of aliases) {
        if (unicodeName(code)) continue;
        const point = Number.parseInt(code, 16);
        const block = blockTermAt(point);
        let score = rank(normalizeName(name), 0, block);
        for (const alias of otherNames)
          score = Math.min(score, rank(normalizeName(alias), 1, block));
        add(point, score);
      }
    }

    if (filter === "all" || filter === "emoji") {
      data.emoji.forEach(([sequence], index) => {
        const name = sequence.includes(" ") ? undefined : unicodeName(sequence);
        if (!name) add(emojiOffset + index, rankEmoji(index));
        else if (filter === "emoji")
          add(
            Number.parseInt(sequence, 16),
            rankEmoji(
              index,
              name,
              aliases.get(sequence),
              blockTermAt(Number.parseInt(sequence, 16)),
            ),
          );
      });
    }

    if (filter === "all" || filter === "nerd") {
      data.nerd.forEach(([, name], index) => {
        const term = normalizeName(name);
        const familyAndName = term.slice(3);
        const familyEnd = familyAndName.indexOf(" ");
        const glyphName = familyAndName.slice(familyEnd + 1);
        const score = Math.min(
          rank(term, 0, "nerd"),
          rank(familyAndName, 1, "nerd"),
          rank(glyphName, 1, "nerd"),
        );
        const group = nerdGroupNames.get(familyAndName.slice(0, familyEnd));
        add(
          nerdOffset + index,
          score === Infinity && group
            ? metadataPenalty + rank("", 0, `nerd ${term} ${group}`)
            : score,
        );
      });
    }

    const exact = new Set([...exactMatches, ...codeMatches]);
    const ordered = [...exactMatches];
    for (const [score, { unicode, nerd }] of buckets.entries()) {
      if (score === 2) {
        for (const index of codeMatches)
          if (!exactMatches.includes(index)) ordered.push(index);
      }
      orderEmoji(unicode);
      // Alternate equally ranked matches from the two catalogs.
      for (
        let index = 0;
        index < Math.max(unicode.length, nerd.length);
        index++
      ) {
        if (index < unicode.length && !exact.has(unicode[index]))
          ordered.push(unicode[index]);
        if (index < nerd.length && !exact.has(nerd[index]))
          ordered.push(nerd[index]);
      }
    }
    return list(ordered);
  }

  function controlPreview(entry: Entry): ControlPreview | undefined {
    if (entry.kind !== "unicode" || entry.codes.length !== 1) return;
    const [code] = entry.codes;
    const point = Number.parseInt(code, 16);
    // Unicode Control Pictures cover C0, SPACE, and DELETE.
    if (point <= 0x20) return { symbol: String.fromCodePoint(0x2400 + point) };
    if (point === 0x7f) return { symbol: "␡" };
    if (/^[\p{Cc}\p{Cf}]$/u.test(entry.character))
      return { label: abbreviations.get(code) ?? `U+${code}` };
  }

  return { search, controlPreview, emojiInfo, previewId: data.previewId };
}
