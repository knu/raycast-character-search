import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const archive = await readFile(
  new URL("../data/nerd-previews.json.gz", import.meta.url),
);
const previewId = createHash("sha256")
  .update(archive)
  .digest("hex")
  .slice(0, 12);
const catalog = await readFile(
  new URL("../assets/catalog.json.gz", import.meta.url),
);
if (JSON.parse(gunzipSync(catalog).toString("utf8")).previewId !== previewId) {
  throw new Error(
    "The glyph previews and character catalog were generated separately",
  );
}
const destination = new URL(`../assets/nerd/${previewId}`, import.meta.url);

if (!existsSync(destination)) {
  const scratch = new URL("../.tmp/", import.meta.url);
  await mkdir(scratch, { recursive: true });
  const staging = await mkdtemp(
    fileURLToPath(new URL("nerd-previews-", scratch)),
  );
  try {
    const previews = JSON.parse(gunzipSync(archive).toString("utf8"));
    const entries = Object.entries(previews);
    for (let start = 0; start < entries.length; start += 128) {
      await Promise.all(
        entries.slice(start, start + 128).map(([code, png]) => {
          if (!/^[0-9A-F]{4,6}$/.test(code))
            throw new Error(`Invalid glyph code: ${code}`);
          return writeFile(join(staging, `${code}.png`), png, "base64");
        }),
      );
    }
    await mkdir(new URL("./", destination), { recursive: true });
    try {
      await rename(staging, destination);
    } catch (error) {
      // A concurrent build may have installed the same set of previews.
      if (error.code !== "ENOTEMPTY" && error.code !== "EEXIST") throw error;
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
