import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";
import { createCatalog, formatCodePoints } from "../src/catalog.mts";

const data = JSON.parse(
  gunzipSync(
    readFileSync(new URL("../assets/catalog.json.gz", import.meta.url)),
  ).toString("utf8"),
);
const catalog = createCatalog(data);

test("exposes every Unicode name with an ARROW word prefix in mixed results", () => {
  const results = catalog.search("arrow", "all");
  const pageSize = 100;
  const firstPage = results.page(0, pageSize);
  assert.ok(firstPage.filter((entry) => entry.kind === "unicode").length > 7);
  assert.ok(firstPage.some((entry) => entry.kind === "nerd"));
  const entries = [];
  for (let offset = 0; offset < results.total; offset += pageSize) {
    entries.push(...results.page(offset, pageSize));
  }
  const expectedCodes = data.names
    .filter(([, name]) => /(?:^|[^A-Z0-9])ARROW/.test(name))
    .map(([code]) => code);
  const actualCodes = new Set(
    entries
      .filter((entry) => entry.kind !== "nerd" && entry.codes.length === 1)
      .map((entry) => entry.codes[0]),
  );
  assert.equal(entries.length, results.total);
  assert.equal(
    new Set(entries.map((entry) => JSON.stringify(entry))).size,
    entries.length,
  );
  assert.deepEqual(
    expectedCodes.filter((code) => !actualCodes.has(code)),
    [],
  );
});

function search(query, filter) {
  const results = catalog.search(query, filter);
  return results.page(0, results.total);
}

test("shares mixed pages and fills unused slots without dropping results", () => {
  const results = catalog.search("circle");
  const pages = results.paginate(100, 50);
  const all = search("circle");
  const nerd = all.filter((entry) => entry.kind === "nerd");
  const unicode = all.filter((entry) => entry.kind !== "nerd");
  let nerdShown = 0;
  let unicodeShown = 0;
  for (let index = 0; index < pages.count; index++) {
    const entries = pages.entries(index);
    assert.equal(pages.offset(index), unicodeShown + nerdShown);
    const size = Math.min(100, all.length - pages.offset(index));
    const nerdCount = Math.min(
      nerd.length - nerdShown,
      size - Math.min(50, unicode.length - unicodeShown),
    );
    const unicodeCount = size - nerdCount;
    assert.deepEqual(entries, [
      ...unicode.slice(unicodeShown, unicodeShown + unicodeCount),
      ...nerd.slice(nerdShown, nerdShown + nerdCount),
    ]);
    unicodeShown += unicodeCount;
    nerdShown += nerdCount;
  }
  assert.equal(pages.offset(pages.count), all.length);
  assert.equal(unicodeShown, unicode.length);
  assert.equal(nerdShown, nerd.length);
});

test("fills a page with one catalog when the other has no results", () => {
  const pages = catalog.search("nf-md", "nerd").paginate(100, 50);
  assert.equal(pages.entries(0).length, 100);
  assert.equal(pages.offset(1), 100);
});

test("finds assigned Unicode characters by literal, name, alias, and hex", () => {
  for (const query of [
    "→",
    "rightwards arrow",
    "2192",
    "U+2192",
    "0x2192",
    "\\u{2192}",
  ]) {
    const [entry] = search(query);
    assert.equal(entry.character, "→", query);
    assert.equal(entry.name, "RIGHTWARDS ARROW", query);
    assert.equal(formatCodePoints(entry), "U+2192");
  }
  assert.equal(search("BOM")[0].character, "\uFEFF");
  assert.equal(search("U+000A")[0].name, "LINE FEED");
  assert.equal(search(" ")[0].name, "SPACE");
});

test("bare hexadecimal queries with a digit match code points exactly", () => {
  assert.deepEqual(search("2192"), search("U+2192"));
  assert.deepEqual(search("f09b"), search("U+F09B"));
});

test("gives control characters visible previews without changing their values", () => {
  for (const [query, character, preview] of [
    ["U+0000", "\u0000", { symbol: "␀" }],
    ["U+0009", "\t", { symbol: "␉" }],
    ["U+000A", "\n", { symbol: "␊" }],
    ["U+007F", "\u007F", { symbol: "␡" }],
    ["U+009B", "\u009B", { label: "CSI" }],
    ["U+200D", "\u200D", { label: "ZWJ" }],
    ["U+2062", "\u2062", { label: "U+2062" }],
  ]) {
    const [entry] = search(query);
    assert.equal(entry.character, character);
    assert.deepEqual(catalog.controlPreview(entry), preview);
  }
  assert.equal(catalog.controlPreview(search("👩‍💻")[0]), undefined);
});

test("expands algorithmic Unicode names and rejects unassigned code points and surrogates", () => {
  assert.equal(search("漢")[0].name, "CJK UNIFIED IDEOGRAPH-6F22");
  assert.equal(search("CJK unified ideograph 20000")[0].character, "𠀀");
  assert.equal(search("U+AC00")[0].name, "HANGUL SYLLABLE GA");
  for (const query of ["U+0378", "U+D800", "U+110000"]) {
    assert.deepEqual(search(query), [], query);
  }
});

test("keeps compound emoji intact and makes their code-point output searchable", () => {
  const emoji = search("woman technologist medium skin tone", "emoji").find(
    (entry) => entry.character === "👩🏽‍💻",
  );
  assert.ok(emoji);
  const codePoints = formatCodePoints(emoji);
  assert.equal(codePoints, "U+1F469 U+1F3FD U+200D U+1F4BB");
  assert.deepEqual(search(codePoints)[0], emoji);
  assert.deepEqual(search("👩🏽‍💻")[0], emoji);
  assert.deepEqual(search(codePoints, "unicode"), []);
  assert.ok(
    search("flag japan", "emoji").some((entry) => entry.character === "🇯🇵"),
  );
  assert.equal(search("❤", "emoji")[0].character, "❤️");
  assert.equal(search("❤")[0].character, "❤");
});

test("resolves Nerd Fonts glyph names, including aliases sharing a code point", () => {
  const [glyph] = search("nf-fa-github", "nerd");
  assert.equal(glyph.name, "nf-fa-github");
  assert.equal(formatCodePoints(glyph), "U+F09B");
  for (const query of ["fa github", "f09b", glyph.character]) {
    assert.ok(
      search(query, "nerd").some((entry) => entry.name === glyph.name),
      query,
    );
  }
  assert.deepEqual(search("nf-fa-github", "unicode"), []);

  const countsByCode = new Map();
  for (const [code] of data.nerd)
    countsByCode.set(code, (countsByCode.get(code) ?? 0) + 1);
  const [sharedCode, count] = [...countsByCode].find(([, count]) => count > 1);
  assert.equal(search(`U+${sharedCode}`, "nerd").length, count);
});

test("finds every emoji and Nerd Fonts glyph using category keywords", () => {
  assert.equal(search("emoji", "emoji").length, data.emoji.length);
  assert.equal(
    search("emoji").filter((entry) => entry.kind === "emoji").length,
    data.emoji.length,
  );
  for (const keyword of ["nf", "nerd"]) {
    assert.equal(search(keyword, "nerd").length, data.nerd.length);
  }
  assert.ok(
    search("emoji woman technologist").some(
      (entry) => entry.character === "👩‍💻",
    ),
  );
  assert.ok(
    search("grinning face emoji").some((entry) => entry.character === "😀"),
  );
  assert.ok(
    search("nerd github").some((entry) => entry.name === "nf-fa-github"),
  );
});

test("ANDs word prefixes and subwords in any order, including category keywords", () => {
  const faces = search("em face", "emoji");
  assert.ok(faces.length > 50);
  assert.ok(faces.some((entry) => entry.character === "😀"));
  const codes = (entries) => entries.map(formatCodePoints).sort();
  assert.deepEqual(codes(search("face em", "emoji")), codes(faces));
  assert.ok(search("ri arr").some((entry) => entry.character === "→"));
  assert.ok(search("wards arr").some((entry) => entry.character === "→"));
  assert.ok(!search("wards banana").some((entry) => entry.character === "→"));
  for (const query of ["ner git", "git nf"]) {
    assert.ok(search(query).some((entry) => entry.name === "nf-fa-github"));
  }
});

test("searches Unicode block names alone and together with character names", () => {
  assert.ok(
    search("basic latin", "unicode").some((entry) => entry.character === "A"),
  );
  assert.ok(
    search("geometric shapes black", "unicode").some(
      (entry) => entry.character === "■",
    ),
  );
  const extension = search("cjk unified ideographs extension c", "unicode");
  const points = extension.map((entry) => Number.parseInt(entry.codes[0], 16));
  assert.ok(points.includes(0x2a700));
  assert.ok(points.every((point) => point >= 0x2a700 && point <= 0x2b73f));
});

test("finds Nerd Fonts family tokens and joins them with subwords", () => {
  const expected = data.nerd.filter(([, name]) => name.startsWith("nf-cod-"));
  const matching = search("cod", "nerd");
  assert.deepEqual(
    matching
      .filter((entry) => entry.name.startsWith("nf-cod-"))
      .map((entry) => entry.name),
    expected.map(([, name]) => name),
  );
  assert.ok(
    catalog
      .search("cod")
      .paginate(100, 50)
      .entries(0)
      .some((entry) => entry.name.startsWith("nf-cod-")),
  );
  assert.equal(search("od termin", "nerd")[0].name, "nf-cod-terminal");
});

test("searches Nerd Fonts group names alone and with glyph names", () => {
  const extraSymbols = data.nerd
    .map(([, name]) => name)
    .filter((name) => name.startsWith("nf-ple-"));
  assert.deepEqual(
    search("powerline-extra-symbols", "nerd").map((entry) => entry.name),
    extraSymbols,
  );
  assert.ok(
    search("powerline extra symbols flame").some(
      (entry) => entry.name === "nf-ple-flame_thick",
    ),
  );
  assert.ok(
    search("font awesome github", "nerd").some(
      (entry) => entry.name === "nf-fa-github",
    ),
  );
});

test("finds GitHub emoji by exact shortcode, partial shortcode, or alias", () => {
  for (const query of [":+1:", ":thumbsup:", "thumbsup", ":thu"]) {
    const [entry] = search(query);
    assert.equal(entry.character, "👍", query);
    assert.deepEqual(catalog.emojiInfo(entry)[0], ["+1", "thumbsup"]);
  }
  assert.equal(search(":heart:")[0].character, "❤️");
  assert.equal(search(":woman_technologist:")[0].character, "👩‍💻");
  assert.deepEqual(search(":heart:", "unicode"), []);
  assert.deepEqual(search(":thumbsup:", "nerd"), []);
  assert.deepEqual(search(":octocat:"), []);
});

test("ANDs emoji prefixes across name, alias, and search tags", () => {
  const [thumb] = search("em thumbsup appr", "emoji");
  assert.equal(thumb.character, "👍");
  assert.ok(catalog.emojiInfo(thumb)[1].includes("approve"));
  const [face] = search("grinning hap", "emoji");
  assert.equal(face.character, "😀");
});

test("orders equally scored emoji by the Unicode chart", () => {
  const firstEmoji = ["😀", "😃", "😄", "😁", "😆", "😅", "😂", "🙂"];
  const faces = catalog.search("emoji face", "emoji");
  assert.deepEqual(
    faces.page(0, 8).map((entry) => entry.character),
    firstEmoji,
  );
});

test("ranks emoji names above search tags when a query includes the category", () => {
  for (const query of ["emoji fish", "fish emoji", "em fish"]) {
    const entries = search(query, "emoji");
    assert.equal(entries[0].character, "🐟", query);
    const names = entries.map((entry) => entry.name);
    const boat = names.indexOf("ROWBOAT");
    const tropicalFish = names.indexOf("TROPICAL FISH");
    const blowfish = names.indexOf("BLOWFISH");
    assert.ok(tropicalFish > 0 && blowfish > tropicalFish && boat > blowfish, query);
  }
});

test("keeps exact and whole-word matches above subwords within each catalog", () => {
  const results = catalog.search("lock");
  const pages = results.paginate(100, 50);
  const entries = Array.from({ length: pages.count }, (_, index) =>
    pages.entries(index),
  ).flat();
  assert.equal(entries[0].character, "🔒");
  const names = entries.map((entry) => entry.name);
  const wholeWord = names.indexOf("OPEN LOCK");
  const nerdExact = names.indexOf("nf-fa-lock");
  assert.ok(wholeWord > 0 && nerdExact >= 50);
  for (const name of ["FULL BLOCK", "ALARM CLOCK"]) {
    assert.ok(names.indexOf(name) > wholeWord, name);
  }
  assert.ok(names.indexOf("nf-fa-clock") > nerdExact);
  assert.equal(search("lock", "emoji")[0].character, "🔒");
});

test("pages broad queries while leaving examples in each filter", () => {
  const results = catalog.search("letter");
  assert.ok(results.total > 100);
  assert.equal(results.page(0, 100).length, 100);
  assert.equal(results.page(results.total - 1, 100).length, 1);
  for (const filter of ["all", "unicode", "emoji", "nerd"]) {
    assert.ok(search("", filter).length > 0, filter);
  }
});
