import { Action, ActionPanel, environment, Icon, List } from "@raycast/api";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { useEffect, useMemo, useState } from "react";
import {
  createCatalog,
  formatCodePoints,
  type CatalogData,
  type Entry,
  type Filter,
} from "./catalog.mjs";

const filters: [Filter, string][] = [
  ["all", "All Characters"],
  ["unicode", "Unicode Characters"],
  ["emoji", "Emoji"],
  ["nerd", "Nerd Fonts"],
];
const pageSize = 100;
// Raycast V2 stopped requesting pages with 700 items already rendered.
const maxPagesInList = 6;
let catalogPromise: Promise<ReturnType<typeof createCatalog>> | undefined;

function loadCatalog() {
  catalogPromise ??= readFile(join(environment.assetsPath, "catalog.json.gz"))
    .then((data) =>
      createCatalog(
        JSON.parse(gunzipSync(data).toString("utf8")) as CatalogData,
      ),
    )
    .catch((error: unknown) => {
      catalogPromise = undefined;
      throw error;
    });
  return catalogPromise;
}

function previewFor(previewId: string, code: string) {
  const asset = `nerd/${previewId}/${code}.png`;
  return existsSync(join(environment.assetsPath, asset)) ? asset : undefined;
}

function entryId(entry: Entry) {
  return `${entry.kind}/${entry.name}/${formatCodePoints(entry)}`;
}

function displayGlyph(character: string): string {
  if (/^[\p{C}\p{White_Space}]+$/u.test(character)) return "";
  return /^\p{M}/u.test(character) ? `◌${character}` : character;
}

function unicodeGlyphImage(glyph: string, badge = false): string | undefined {
  if (!glyph) return;
  // Keep glyphs out of list titles, which can stall rendering in Raycast V2.
  const entities = Array.from(
    glyph,
    (character) => `&#${character.codePointAt(0)};`,
  ).join("");
  const fill = environment.theme === "light" ? "#202639" : "#f4f6ff";
  const content = badge
    ? `<rect x="5" y="26" width="102" height="60" rx="9" fill="none" stroke="${fill}" stroke-width="4"/><text x="56" y="56" dominant-baseline="central" text-anchor="middle" font-family="monospace" font-size="${Math.min(36, Math.floor(140 / glyph.length))}" font-weight="bold" fill="${fill}">${entities}</text>`
    : `<text x="56" y="82" text-anchor="middle" font-family="sans-serif" font-size="78" fill="${fill}">${entities}</text>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="112" height="112" viewBox="0 0 112 112">${content}</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

function CharacterDetail({
  entry,
  preview,
  codePoints,
  shortcodes,
  keywords,
}: {
  entry: Entry;
  preview: string | undefined;
  codePoints: string;
  shortcodes: string[];
  keywords: string[];
}) {
  // Vicinae decodes everything after the data URI's comma as image content.
  const imageSource =
    preview && !preview.startsWith("data:")
      ? `${preview}?raycast-width=112&raycast-height=112`
      : preview;
  const markdown = imageSource && `![Glyph preview](${imageSource})`;
  return (
    <List.Item.Detail
      markdown={markdown}
      metadata={
        <List.Item.Detail.Metadata>
          <List.Item.Detail.Metadata.Label title="Name" text={entry.name} />
          <List.Item.Detail.Metadata.Label
            title="Code Point"
            text={codePoints}
          />
          {shortcodes.length > 0 && (
            <List.Item.Detail.Metadata.Label
              title="GitHub"
              text={shortcodes.join(", ")}
            />
          )}
          {keywords.length > 0 && (
            <List.Item.Detail.Metadata.Label
              title="Search Tags"
              text={keywords.join(", ")}
            />
          )}
        </List.Item.Detail.Metadata>
      }
    />
  );
}

type SearchState = {
  query: string;
  filter: Filter;
  firstPage: number;
  pageCount: number;
  selectedId?: string;
};

export default function SearchCharacters() {
  const [catalog, setCatalog] =
    useState<Awaited<ReturnType<typeof loadCatalog>>>();
  const [failed, setFailed] = useState(false);
  const [{ query, filter, firstPage, pageCount, selectedId }, setSearchState] =
    useState<SearchState>({
      query: "",
      filter: "all",
      firstPage: 0,
      pageCount: 1,
    });
  useEffect(() => {
    let active = true;
    loadCatalog().then(
      (loaded) => {
        if (active) setCatalog(loaded);
      },
      (error: unknown) => {
        console.error(error);
        if (active) setFailed(true);
      },
    );
    return () => {
      active = false;
    };
  }, []);
  const matches = useMemo(
    () => catalog?.search(query, filter),
    [catalog, query, filter],
  );
  const pages = useMemo(
    () =>
      matches?.paginate(pageSize, filter === "all" ? pageSize / 2 : undefined),
    [matches, filter],
  );
  const total = matches?.total ?? 0;
  const nextPage = firstPage + pageCount;
  const hasMore = nextPage < (pages?.count ?? 0);
  const canAppend = hasMore && pageCount < maxPagesInList;
  const showContinue = hasMore && (!canAppend || firstPage > 0);
  const continueTitle = `Continue from Result ${(pages?.offset(nextPage) ?? 0) + 1}`;
  const continueId = `continue/${nextPage}`;
  const sections = useMemo(() => {
    if (!pages) return [];
    return Array.from({ length: pageCount }, (_, index) => {
      const page = firstPage + index;
      const offset = pages.offset(page);
      const entries = pages.entries(page);
      const range =
        pages.count > 1
          ? `${offset + 1}–${offset + entries.length} of ${total}`
          : undefined;
      return [
        {
          key: "unicode",
          entries: entries.filter((entry) => entry.kind !== "nerd"),
        },
        {
          key: "nerd",
          title: filter === "all" ? "Nerd Fonts" : undefined,
          entries: entries.filter((entry) => entry.kind === "nerd"),
        },
      ]
        .filter((section) => section.entries.length > 0)
        .map((section, index) => ({
          ...section,
          key: JSON.stringify([query, filter, page, section.key]),
          title: section.title ?? (index === 0 ? range : undefined),
          subtitle: section.title && index === 0 ? range : undefined,
        }));
    }).flat();
  }, [filter, firstPage, pages, pageCount, query, total]);
  const selectedEntry =
    sections
      .map((section) =>
        section.entries.find((entry) => entryId(entry) === selectedId),
      )
      .find((entry) => entry !== undefined) ?? sections[0]?.entries[0];

  function showResultsFrom(page: number) {
    setSearchState((state) =>
      state.query === query && state.filter === filter
        ? { query, filter, firstPage: page, pageCount: 1 }
        : state,
    );
  }

  function updateQuery(text: string) {
    setSearchState((state) =>
      state.query === text
        ? state
        : { query: text, filter: state.filter, firstPage: 0, pageCount: 1 },
    );
  }

  const clearSearch = query && (
    <Action
      title="Clear Search"
      shortcut={{ modifiers: ["ctrl"], key: "u" }}
      onAction={() => updateQuery("")}
    />
  );

  return (
    <List
      isLoading={!catalog && !failed}
      isShowingDetail
      filtering={false}
      throttle
      searchBarPlaceholder="Search by character, name, or code point"
      searchText={query}
      actions={
        !selectedEntry && clearSearch ? (
          <ActionPanel>{clearSearch}</ActionPanel>
        ) : undefined
      }
      selectedItemId={selectedEntry && entryId(selectedEntry)}
      pagination={{
        pageSize,
        hasMore: canAppend,
        onLoadMore: () => {
          setSearchState((state) =>
            state.query === query &&
            state.filter === filter &&
            state.firstPage === firstPage &&
            state.pageCount === pageCount &&
            canAppend
              ? { ...state, pageCount: pageCount + 1 }
              : state,
          );
        },
      }}
      onSelectionChange={(id) => {
        if (showContinue && id === continueId) {
          showResultsFrom(nextPage);
        } else if (id !== null) {
          setSearchState((state) =>
            state.selectedId === id ? state : { ...state, selectedId: id },
          );
        }
      }}
      onSearchTextChange={updateQuery}
      searchBarAccessory={
        <List.Dropdown
          tooltip="Character set"
          value={filter}
          onChange={(value) => {
            setSearchState((state) =>
              state.filter === value
                ? state
                : {
                    query: state.query,
                    filter: value as Filter,
                    firstPage: 0,
                    pageCount: 1,
                  },
            );
          }}
        >
          {filters.map(([value, label]) => (
            <List.Dropdown.Item key={value} value={value} title={label} />
          ))}
        </List.Dropdown>
      }
    >
      {catalog || failed ? (
        <List.EmptyView
          icon={failed ? Icon.Warning : Icon.MagnifyingGlass}
          title={failed ? "Could Not Load Characters" : "No Characters Found"}
          description={
            failed
              ? undefined
              : "Try a character, name, or code point such as U+2192."
          }
        />
      ) : null}
      {sections.map(({ key, title, subtitle, entries }) => (
        <List.Section key={key} title={title} subtitle={subtitle}>
          {entries.map((entry) => {
            const codePoints = formatCodePoints(entry);
            const [names, keywords] = (entry === selectedEntry &&
              catalog?.emojiInfo(entry)) || [[], []];
            const shortcodes = names.map((name) => `:${name}:`);
            const nerdPreview =
              catalog && entry.kind === "nerd"
                ? previewFor(catalog.previewId, entry.codes[0])
                : undefined;
            const control = catalog?.controlPreview(entry);
            const preview =
              nerdPreview ??
              (control && "label" in control
                ? unicodeGlyphImage(control.label, true)
                : unicodeGlyphImage(
                    control?.symbol ?? displayGlyph(entry.character),
                  ));
            return (
              <List.Item
                key={entryId(entry)}
                id={entryId(entry)}
                title={entry.name}
                icon={preview}
                detail={
                  entry === selectedEntry && (
                    <CharacterDetail
                      entry={entry}
                      preview={preview}
                      codePoints={codePoints}
                      shortcodes={shortcodes}
                      keywords={keywords}
                    />
                  )
                }
                actions={
                  entry === selectedEntry && (
                    <ActionPanel>
                      <ActionPanel.Section>
                        <Action.Paste
                          title="Paste Character"
                          content={entry.character}
                        />
                        <Action.CopyToClipboard
                          title="Copy Character"
                          content={entry.character}
                        />
                      </ActionPanel.Section>
                      <ActionPanel.Section>
                        <Action.Paste title="Paste Name" content={entry.name} />
                        <Action.CopyToClipboard
                          title="Copy Name"
                          content={entry.name}
                        />
                        <Action.Paste
                          title="Paste Code Point"
                          content={codePoints}
                        />
                        <Action.CopyToClipboard
                          title="Copy Code Point"
                          content={codePoints}
                        />
                      </ActionPanel.Section>
                      {shortcodes.length > 0 && (
                        <ActionPanel.Section title="GitHub Shortcodes">
                          {shortcodes.flatMap((shortcode) => [
                            <Action.Paste
                              key={`paste/${shortcode}`}
                              title={`Paste ${shortcode}`}
                              content={shortcode}
                            />,
                            <Action.CopyToClipboard
                              key={`copy/${shortcode}`}
                              title={`Copy ${shortcode}`}
                              content={shortcode}
                            />,
                          ])}
                        </ActionPanel.Section>
                      )}
                      {(hasMore || firstPage > 0) && (
                        <ActionPanel.Section>
                          {hasMore && (
                            <Action
                              icon={Icon.ArrowDown}
                              title={continueTitle}
                              shortcut={{
                                modifiers: ["cmd", "opt"],
                                key: "arrowRight",
                              }}
                              onAction={() => showResultsFrom(nextPage)}
                            />
                          )}
                          {firstPage > 0 && (
                            <Action
                              icon={Icon.ArrowUp}
                              title="Return to First Results"
                              shortcut={{
                                modifiers: ["cmd", "opt"],
                                key: "arrowLeft",
                              }}
                              onAction={() => showResultsFrom(0)}
                            />
                          )}
                        </ActionPanel.Section>
                      )}
                      {clearSearch && (
                        <ActionPanel.Section>{clearSearch}</ActionPanel.Section>
                      )}
                    </ActionPanel>
                  )
                }
              />
            );
          })}
        </List.Section>
      ))}
      {showContinue && (
        <List.Section>
          <List.Item
            id={continueId}
            title={continueTitle}
            icon={Icon.ArrowDown}
            actions={
              <ActionPanel>
                <Action
                  title={continueTitle}
                  onAction={() => showResultsFrom(nextPage)}
                />
                {clearSearch}
              </ActionPanel>
            }
          />
        </List.Section>
      )}
    </List>
  );
}
