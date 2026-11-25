import { spawnSync } from "node:child_process";
import { mkdir, readFile, readlink, symlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const workspace = new URL(".tmp/raycast-test/", root);

await mkdir(workspace, { recursive: true });
for (const name of ["src", "assets", "node_modules", "tsconfig.json"]) {
  const source = fileURLToPath(new URL(name, root));
  const target = new URL(name, workspace);
  try {
    await symlink(source, target);
  } catch (error) {
    if (error.code !== "EEXIST" || (await readlink(target)) !== source)
      throw error;
  }
}

const manifest = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
manifest.name = `${manifest.name}-shortcut-test`;
manifest.title = `${manifest.title} Shortcut Test`;
for (const command of manifest.commands) {
  command.title = "Test Character Search Shortcuts";
}
await writeFile(
  new URL("package.json", workspace),
  JSON.stringify(manifest, null, 2) + "\n",
);

const ray = spawnSync(
  "ray",
  ["develop", "--exit-on-error", ...process.argv.slice(2)],
  { cwd: workspace, stdio: "inherit" },
);
if (ray.error) throw ray.error;
process.exitCode = ray.status ?? (ray.signal === "SIGINT" ? 130 : 1);
