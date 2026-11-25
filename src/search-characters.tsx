import {
  Action,
  ActionPanel,
  Clipboard,
  closeMainWindow,
  Color,
  environment,
  Icon,
  type Keyboard,
  launchCommand,
  type LaunchProps,
  LaunchType,
  List,
  PopToRootType,
  showToast,
  Toast,
} from "@raycast/api";
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

function formatUnicodeEscapes(entry: Entry): string {
  return entry.codes
    .map((code) => (code.length > 4 ? `\\u{${code}}` : `\\u${code}`))
    .join("");
}

type OutputChoice = {
  id: string;
  label: string;
  content: string;
  key?: Keyboard.KeyEquivalent;
};

function outputChoices(entry: Entry, shortcodes: string[]): OutputChoice[] {
  const codeNames = entry.kind === "nerd" ? [entry.name] : shortcodes;
  return [
    { id: "c", key: "c", label: "Character", content: entry.character },
    { id: "n", key: "n", label: "Name", content: entry.name },
    { id: "u", key: "u", label: "Code Point", content: formatCodePoints(entry) },
    {
      id: "x",
      key: "x",
      label: "Hexadecimal Code",
      content: entry.codes.join(" "),
    },
    {
      id: "j",
      key: "j",
      label: "Unicode Escape",
      content: formatUnicodeEscapes(entry),
    },
    ...codeNames.map((content, index): OutputChoice => ({
      id: index === 0 ? "g" : content,
      key: index === 0 ? "g" : undefined,
      label: content,
      content,
    })),
  ];
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

function DetailField({
  title,
  value,
  selected,
}: {
  title: string;
  value: string;
  selected: boolean;
}) {
  return (
    <List.Item.Detail.Metadata.Label
      title={title}
      text={selected ? { value, color: Color.Blue } : value}
      icon={selected ? { source: Icon.Check, tintColor: Color.Blue } : undefined}
    />
  );
}

function CharacterDetail({
  entry,
  preview,
  codePoints,
  shortcodes,
  keywords,
  output,
}: {
  entry: Entry;
  preview: string | undefined;
  codePoints: string;
  shortcodes: string[];
  keywords: string[];
  output: OutputChoice;
}) {
  // Vicinae decodes everything after the data URI's comma as image content.
  const imageSource =
    preview && !preview.startsWith("data:")
      ? `${preview}?raycast-width=112&raycast-height=112`
      : preview;
  const markdown = imageSource && `![Glyph preview](${imageSource})`;
  const codeNameSelected = output.id === "g" || shortcodes.includes(output.id);
  return (
    <List.Item.Detail
      markdown={markdown}
      metadata={
        <List.Item.Detail.Metadata>
          <DetailField
            title="Name"
            value={entry.name}
            selected={
              output.id === "n" || (entry.kind === "nerd" && codeNameSelected)
            }
          />
          <DetailField
            title="Code Point"
            value={codePoints}
            selected={output.id === "u"}
          />
          <DetailField
            title="Hexadecimal Code"
            value={entry.codes.join(" ")}
            selected={output.id === "x"}
          />
          <DetailField
            title="Unicode Escape"
            value={formatUnicodeEscapes(entry)}
            selected={output.id === "j"}
          />
          {shortcodes.length > 0 && (
            <DetailField
              title="GitHub"
              value={shortcodes.join(", ")}
              selected={codeNameSelected}
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

type ResumeContext = { search: SearchState; outputId: string };

async function pasteAndContinue(content: string, context: ResumeContext) {
  const [major, minor] = (environment.raycastVersion ?? "").split(".").map(Number);
  if (major > 2 || (major === 2 && minor >= 10)) {
    // Raycast 2.10 added this option after the pinned API types were published.
    const paste: (
      text: string,
      options: { closeMainWindow: boolean },
    ) => Promise<void> = Clipboard.paste;
    await paste(content, { closeMainWindow: false });
    return;
  }

  await closeMainWindow({ popToRootType: PopToRootType.Suspended });
  await Clipboard.paste(content);
  await launchCommand({
    name: environment.commandName,
    type: LaunchType.UserInitiated,
    context: { resume: context },
  });
}

export default function SearchCharacters({
  launchContext,
}: LaunchProps<{ launchContext: { resume?: ResumeContext } }>) {
  const [catalog, setCatalog] =
    useState<Awaited<ReturnType<typeof loadCatalog>>>();
  const [failed, setFailed] = useState(false);
  const [outputId, setOutputId] = useState(launchContext?.resume?.outputId ?? "c");
  const [searchState, setSearchState] = useState<SearchState>(
    launchContext?.resume?.search ?? {
      query: "",
      filter: "all",
      firstPage: 0,
      pageCount: 1,
    },
  );
  const { query, filter, firstPage, pageCount, selectedId } = searchState;
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
  const groupCatalogs = filter === "all";
  const pages = useMemo(
    () =>
      matches?.paginate(pageSize, groupCatalogs ? pageSize / 2 : undefined),
    [matches, groupCatalogs],
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
      if (!groupCatalogs) {
        return [
          {
            key: JSON.stringify([query, filter, page]),
            title: range,
            subtitle: undefined,
            entries,
          },
        ];
      }
      return [
        {
          key: "unicode",
          entries: entries.filter((entry) => entry.kind !== "nerd"),
        },
        {
          key: "nerd",
          title: "Nerd Fonts",
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
  }, [filter, firstPage, groupCatalogs, pages, pageCount, query, total]);
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
            const isSelected = entry === selectedEntry;
            const codePoints = formatCodePoints(entry);
            const [names, keywords] =
              (isSelected && catalog?.emojiInfo(entry)) || [[], []];
            const shortcodes = names.map((name) => `:${name}:`);
            const choices = isSelected ? outputChoices(entry, shortcodes) : [];
            const output = choices.find(({ id }) => id === outputId) ?? choices[0];
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
                  output && (
                    <CharacterDetail
                      entry={entry}
                      preview={preview}
                      codePoints={codePoints}
                      shortcodes={shortcodes}
                      keywords={keywords}
                      output={output}
                    />
                  )
                }
                actions={
                  output && (
                    <ActionPanel>
                      <ActionPanel.Section>
                        <Action.Paste
                          title={`Paste ${output.label}`}
                          content={output.content}
                        />
                        <Action.CopyToClipboard
                          title={`Copy ${output.label}`}
                          content={output.content}
                          shortcut={{ modifiers: ["cmd"], key: "c" }}
                        />
                        <Action
                          title={`Paste ${output.label} and Continue`}
                          shortcut={{ modifiers: ["shift"], key: "enter" }}
                          onAction={() =>
                            pasteAndContinue(output.content, {
                              search: {
                                ...searchState,
                                selectedId: entryId(entry),
                              },
                              outputId,
                            })
                          }
                        />
                        <Action
                          title={`Copy ${output.label} and Continue`}
                          // Keep this distinct from Vicinae's configurable Copy shortcut.
                          // eslint-disable-next-line @raycast/prefer-common-shortcut
                          shortcut={{ modifiers: ["cmd", "shift"], key: "c" }}
                          onAction={async () => {
                            await Clipboard.copy(output.content);
                            await showToast({
                              style: Toast.Style.Success,
                              title: "Copied to Clipboard",
                            });
                          }}
                        />
                      </ActionPanel.Section>
                      <ActionPanel.Section title="Output Format">
                        {choices.map(({ id, label, key }) => (
                          <Action
                            key={id}
                            title={`Use ${label}`}
                            icon={id === output.id ? Icon.Check : undefined}
                            shortcut={
                              key ? { modifiers: ["opt"], key } : undefined
                            }
                            onAction={() => setOutputId(id)}
                          />
                        ))}
                      </ActionPanel.Section>
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
