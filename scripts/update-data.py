"""Build the catalog and previews from the pinned upstream files."""

import argparse
import base64
import gzip
import hashlib
import io
import json
import re
import shutil
from collections import Counter
from collections.abc import Iterator
from pathlib import Path
from urllib.parse import urlsplit
from xml.etree import ElementTree

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
# DerivedName.txt, NameAliases.txt, and Blocks.txt are in the versioned UCD.
# Use emoji/emoji-test.txt from the same Unicode release.
UNICODE_VERSION = "18.0.0"
# Use glyphnames.json and the license and font from NerdFontsSymbolsOnly.tar.xz.
NERD_FONTS_VERSION = "3.5.1"
# Source files for emoji metadata:
# https://api.github.com/emojis -> github-emojis.json
# github/gemoji v4.1.0 db/emoji.json and LICENSE -> gemoji.json, LICENSE-Gemoji.txt
# unicode-org/cldr release-49 common/{annotations,annotationsDerived}/en.xml
# -> cldr-en.xml, cldr-derived-en.xml, plus LICENSE -> LICENSE-CLDR.txt


def records(path: Path) -> Iterator[tuple[list[str], str]]:
    with path.open(encoding="utf-8") as source:
        for line in source:
            fields, _, comment = line.partition("#")
            if fields.strip():
                yield [field.strip() for field in fields.split(";")], comment.strip()


def write_gzip(path: Path, data: object) -> bytes:
    encoded = json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode()
    compressed = gzip.compress(encoded, mtime=0)
    path.write_bytes(compressed)
    return compressed


def render_preview(font: ImageFont.FreeTypeFont, glyph: str) -> str:
    left, top, right, bottom = font.getbbox(glyph)
    mask = Image.new("L", (right - left, bottom - top))
    ImageDraw.Draw(mask).text((-left, -top), glyph, font=font, fill=255)
    box = mask.getbbox()
    if box is None:
        return ""
    mask = mask.crop(box)
    mask.thumbnail((96, 96), Image.Resampling.LANCZOS)
    preview = Image.new("P", (112, 112))
    preview.putpalette([94, 135, 239] * 16)
    ink = mask.point([round(level / 17) for level in range(256)])
    preview.paste(
        ink, ((preview.width - mask.width) // 2, (preview.height - mask.height) // 2)
    )
    buffer = io.BytesIO()
    preview.save(buffer, format="PNG", bits=4, transparency=bytes(range(0, 256, 17)))
    return base64.b64encode(buffer.getvalue()).decode("ascii")


def emoji_metadata(source: Path, emoji: list[list[str]]) -> dict[str, list[list[str]]]:
    def github_key(sequence: str) -> str:
        # GitHub's image URLs omit emoji presentation selectors and joiners.
        return "-".join(
            f"{int(code, 16):x}"
            for code in sequence.split()
            if code not in {"FE0F", "200D"}
        )

    def emoji_key(character: str) -> str:
        return character.replace("\ufe0f", "")

    github_api = json.loads((source / "github-emojis.json").read_text(encoding="utf-8"))
    github_aliases: dict[str, list[str]] = {}
    for alias, url in github_api.items():
        path = urlsplit(url).path
        if re.fullmatch(r"[a-z0-9_+-]+", alias) and (
            match := re.search(r"/unicode/([0-9a-f-]+)\.png$", path)
        ):
            key = github_key(match[1].upper().replace("-", " "))
            github_aliases.setdefault(key, []).append(alias)

    gemoji = json.loads((source / "gemoji.json").read_text(encoding="utf-8"))
    github_details = {emoji_key(item["emoji"]): item for item in gemoji}
    annotations: dict[str, list[str]] = {}
    for path in ("cldr-en.xml", "cldr-derived-en.xml"):
        for annotation in ElementTree.parse(source / path).iterfind(
            "./annotations/annotation"
        ):
            text = annotation.text
            if text is None or text.strip() == "↑↑↑":
                continue
            annotations.setdefault(emoji_key(annotation.attrib["cp"]), []).extend(
                term.strip() for term in text.split("|") if term.strip()
            )

    keys = [github_key(sequence) for sequence, _ in emoji]
    ambiguous = {key for key, count in Counter(keys).items() if count > 1}
    metadata = {}
    for (sequence, short_name), key in zip(emoji, keys, strict=True):
        character = emoji_key("".join(chr(int(code, 16)) for code in sequence.split()))
        github = github_details.get(character, {})
        aliases = sorted(github_aliases.get(key, []))
        preferred = [name for name in github.get("aliases", []) if name in aliases]
        if key in ambiguous:
            aliases = preferred
        else:
            aliases = list(dict.fromkeys([*preferred, *aliases]))
        keywords = [
            *github.get("tags", []),
            *annotations.get(character, []),
        ]
        if description := github.get("description"):
            keywords.append(description)
        keywords = list(
            dict.fromkeys(
                term.casefold()
                for term in keywords
                if term.casefold() != short_name.casefold()
            )
        )
        if aliases or keywords:
            metadata[sequence] = [aliases, keywords]
    return metadata


def write_catalog(source: Path, catalog: dict) -> None:
    catalog["emojiMetadata"] = emoji_metadata(source, catalog["emoji"])
    for license_name in ("LICENSE-Gemoji.txt", "LICENSE-CLDR.txt"):
        shutil.copyfile(source / license_name, ROOT / "assets" / license_name)
    write_gzip(ROOT / "assets" / "catalog.json.gz", catalog)


def unicode_blocks(path: Path) -> list[list[str]]:
    with path.open(encoding="utf-8") as source:
        if source.readline().rstrip() != f"# Blocks-{UNICODE_VERSION}.txt":
            raise ValueError("Unexpected Unicode block data version")
    return [fields for fields, _ in records(path)]


def main(source: Path) -> None:
    derived_names = source / "DerivedName.txt"
    emoji_test = source / "emoji-test.txt"
    if not derived_names.read_text(encoding="utf-8").startswith(
        f"# DerivedName-{UNICODE_VERSION}.txt"
    ):
        raise ValueError("Unexpected Unicode data version")
    emoji_version = UNICODE_VERSION.rsplit(".", 1)[0]
    if f"# Version: {emoji_version}\n" not in emoji_test.read_text(encoding="utf-8"):
        raise ValueError("Unexpected emoji data version")

    names = [fields for fields, _ in records(derived_names)]
    aliases = [fields for fields, _ in records(source / "NameAliases.txt")]
    blocks = unicode_blocks(source / "Blocks.txt")
    emoji = []
    for (codes, status), comment in records(emoji_test):
        if status in {"fully-qualified", "component"}:
            match = re.fullmatch(r"\S+\s+E[\d.]+\s+(.+)", comment)
            if match is None:
                raise ValueError(f"Unexpected emoji record: {codes}")
            emoji.append([codes, match[1]])

    with (source / "glyphnames.json").open(encoding="utf-8") as file:
        glyphs = json.load(file)
    if glyphs.pop("METADATA")["version"] != NERD_FONTS_VERSION:
        raise ValueError("Unexpected Nerd Fonts glyph data version")

    nerd = []
    previews: dict[str, str] = {}
    font = ImageFont.truetype(source / "SymbolsNerdFont-Regular.ttf", size=256)
    for name, glyph in glyphs.items():
        code = glyph["code"].upper().zfill(4)
        if chr(int(code, 16)) != glyph["char"]:
            raise ValueError(f"Invalid Nerd Fonts glyph: {name}")
        nerd.append([code, f"nf-{name}"])
        if code not in previews:
            previews[code] = render_preview(font, glyph["char"])

    (ROOT / "data").mkdir(exist_ok=True)
    preview_archive = write_gzip(
        ROOT / "data" / "nerd-previews.json.gz",
        {code: png for code, png in previews.items() if png},
    )
    write_catalog(
        source,
        {
            "names": names,
            "aliases": aliases,
            "blocks": blocks,
            "emoji": emoji,
            "nerd": nerd,
            "previewId": hashlib.sha256(preview_archive).hexdigest()[:12],
        },
    )
    shutil.copyfile(source / "license.txt", ROOT / "assets" / "LICENSE-Unicode.txt")
    shutil.copyfile(source / "LICENSE", ROOT / "assets" / "LICENSE-Nerd-Fonts.txt")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="Directory with upstream input files")
    updates = parser.add_mutually_exclusive_group()
    updates.add_argument(
        "--emoji-metadata-only",
        action="store_true",
        help="Update emoji aliases and keywords in the existing catalog",
    )
    updates.add_argument(
        "--unicode-blocks-only",
        action="store_true",
        help="Update Unicode block names in the existing catalog",
    )
    args = parser.parse_args()
    if args.emoji_metadata_only or args.unicode_blocks_only:
        path = ROOT / "assets" / "catalog.json.gz"
        with gzip.open(path, "rt", encoding="utf-8") as stream:
            catalog = json.load(stream)
        if args.emoji_metadata_only:
            write_catalog(args.source, catalog)
        else:
            catalog["blocks"] = unicode_blocks(args.source / "Blocks.txt")
            write_gzip(path, catalog)
    else:
        main(args.source)
