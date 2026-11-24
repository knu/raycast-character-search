# Character Search

A Raycast and Vicinae extension for searching and previewing Unicode characters, emoji, and Nerd Fonts glyphs.

Open **Search Characters** and search by character, name, code point, Unicode block, emoji tag, or GitHub shortcode.  Use the action panel to copy or paste the character, its name, its code point, or a GitHub shortcode when available.  Press Ctrl+U to clear the search.

## Install from source

Use Node.js 24.  From this directory, run `npm ci`, then follow the steps for your launcher.

**Raycast on macOS.** Run `npm run dev` to register the extension.  Once **Search Characters** appears in Raycast, stop the development process with Ctrl+C.

**Vicinae.** Run `npm run build:vicinae`.  Place the generated `dist/vicinae/character-search` directory in `~/.local/share/vicinae/extensions/` or the extensions directory under your configured data directory.

## Install with mise

Add the following to `~/.config/mise/conf.d/character-search.toml`:

```toml
[tool_alias]
raycast-character-search = "github:knu/raycast-character-search"
vicinae-character-search = "github:knu/raycast-character-search"

[tools.raycast-character-search]
version = "latest"
asset_pattern = "character-search-raycast.tar.gz"
strip_components = 1
bin_path = "."

[tools.vicinae-character-search]
version = "latest"
asset_pattern = "character-search-vicinae.tar.gz"
strip_components = 1
bin_path = "."
```

Keep the alias and tool table for each launcher you use.  For this private repository, supply a [mise GitHub token](https://mise.jdx.dev/dev-tools/github-tokens) with read access to the repository.  If your GitHub CLI is already authenticated with that access, replace `mise install ...` below with `MISE_GITHUB_TOKEN="$(gh auth token)" mise install ...`.

### Raycast

Register the extension once on each Mac using the Raycast source installation above.  After stopping `npm run dev`, move the generated `~/.config/raycast/extensions/character-search` directory outside `extensions` as a backup.  Then run:

```sh
mise install raycast-character-search
mkdir -p "$HOME/.config/raycast/extensions"
ln -s "$HOME/.local/share/mise/installs/raycast-character-search/latest" \
  "$HOME/.config/raycast/extensions/character-search"
```

Move the symlink aside before running `npm run dev` again.  The development build writes to the extension path.

### Vicinae

Move any existing `character-search` extension directory outside `extensions` as a backup, then run:

```sh
mise install vicinae-character-search
mkdir -p "${XDG_DATA_HOME:-$HOME/.local/share}/vicinae/extensions"
ln -s "$HOME/.local/share/mise/installs/vicinae-character-search/latest" \
  "${XDG_DATA_HOME:-$HOME/.local/share}/vicinae/extensions/character-search"
```

The links use mise's default data directory.  Adjust the target if you set `MISE_DATA_DIR`.  Run `mise upgrade` with the launcher alias to update the installed extension.

## License

MIT.  See [LICENSE](LICENSE) and the [bundled data notices](assets).
