# GitProbe

**GitHub Intelligence CLI** by NullKat Development.

GitProbe is a single-file Node.js tool that runs in your terminal (Android Termux or an Ubuntu VPS) and analyzes public GitHub profiles and repositories through the official GitHub REST API. It has an animated splash screen, a numbered interactive menu, and a clean dark red-and-white theme with a live RGB effect.

- One file: `probe.js`
- Zero dependencies: only Node.js built-in modules
- Real data only: nothing is simulated or invented; missing values show as `Not available`
- Works without a token (60 requests/hour); an optional token raises the limit

---

## Requirements

- Node.js **14 or newer**
- An internet connection
- A terminal with UTF-8 support (colors are optional)

## Installation

### Termux (Android)

```bash
pkg update && pkg install nodejs -y
node probe.js
```

### Ubuntu / Debian VPS

```bash
sudo apt update && sudo apt install nodejs -y
node probe.js
```

If your distribution ships an old Node.js (check with `node --version`), install a newer one from [NodeSource](https://github.com/nodesource/distributions) or with `nvm`.

No `npm install` is needed. There are no packages to download.

### Verify the file

A copy that was cut off during transfer will fail with `SyntaxError: Unexpected end of input`. Check it before running:

```bash
node --check probe.js && echo OK
```

---

## Start it by typing `probe`

Install the launcher once:

```bash
node probe.js --install
```

You can also do it from the menu: **7 Settings & About → 7 Install 'probe' command**.

After that, just type:

```bash
probe
```

| Environment | Where the command is installed | PATH |
|---|---|---|
| Termux | `$PREFIX/bin/probe` | Already in PATH |
| Ubuntu as root | `/usr/local/bin/probe` | Already in PATH |
| Ubuntu as a normal user | `~/.local/bin/probe` | GitProbe offers to add it to `~/.bashrc` |

Notes:

- The launcher is a tiny shell script that runs `node` with the full path of `probe.js`. If you move `probe.js`, run `node probe.js --install` again.
- GitProbe never overwrites a different `probe` command that already exists.
- If the shell says `command not found` right after installing, run `hash -r` or reopen the terminal.
- To remove it: `node probe.js --uninstall` (or menu item 7 → 8).

Prefer an alias instead?

```bash
echo "alias probe='node ~/probe.js'" >> ~/.bashrc && source ~/.bashrc
```

---

## Using GitProbe

On start you see the animated PROBE logo and a connection check. Press **Enter** to open the main menu.

```
[1] Analyze GitHub Profile
[2] Analyze Repository
[3] Repository Explorer
[4] README Viewer
[5] Statistics & Insights
[6] Export Report
[7] Settings & About
[8] Exit
```

Type a number and press Enter. `0` always goes back.

### 1. Analyze GitHub Profile

Enter a username or a profile URL:

```
nullkat-067
https://github.com/nullkat-067
```

Shows: username, display name, bio, profile URL, avatar URL, location, website, followers, following, public repositories, account creation date, last profile update, total stars (from loaded repositories), top languages, featured repositories, and the profile README when it exists.

From the profile screen you can open the profile README, browse repositories, view statistics, export a report, or refresh the data.

### 2. Analyze Repository

Enter `owner/repository` or a full repository URL:

```
nullkat-067/TraceVoid
https://github.com/nullkat-067/TraceVoid
```

Shows: name, owner, description, URL, stars, forks, watchers, open issues, main language, default branch, size, license, topics, fork status, creation date, last update, last push, and README availability. Sub-menu options: view README, extra metadata (clone URLs, features, language breakdown), show the summary again, export.

### 3. Repository Explorer

Browse a user's public repositories, eight per page.

| Key | Action |
|---|---|
| `#` (a number) | Open that repository's details |
| `N` / `P` | Next / previous page |
| `S` | Cycle sorting: recently updated → most stars → name |
| `F` | Search by repository name (empty input clears the filter) |
| `L` | Load more repositories from GitHub |
| `0` | Back |

### 4. README Viewer

Reads a profile README or a repository README inside the terminal, with headings, lists, links, code blocks and tables rendered in a readable form.

| Key | Action |
|---|---|
| `Enter` or `N` | Next page |
| `P` | Previous page |
| `#` | Jump to a page number |
| `S` | Save the README as a TXT file |
| `0` | Back |

### 5. Statistics & Insights

Statistics GitProbe calculates from the repositories it actually loaded: total stars, total forks, own / forked / archived counts, most starred repository, newest repository, most recently updated repository, language breakdown, and a summary of recent public activity from GitHub's public events feed.

Results are marked **PARTIAL** when not every repository could be loaded. GitProbe keeps data provided directly by GitHub separate from numbers it calculates itself.

### 6. Export Report

Saves a report you have already analyzed as **JSON**, **TXT**, or both.

- Files are written to the current folder, or to the folder in `GITPROBE_OUT_DIR`
- File names look like `gitprobe_profile_<user>_<timestamp>.json`
- Each report records when the data was fetched and whether it is complete or partial
- Reports contain public GitHub data only. Your token is never included. Nothing is uploaded anywhere.

### 7. Settings & About

Toggle colors, the RGB effect and animations; view About information, the usage guide and your current API rate limit; install or remove the `probe` command.

---

## Command-line options

```
node probe.js [options]
```

| Option | Description |
|---|---|
| `--install` | Install the `probe` command |
| `--uninstall` | Remove the `probe` command |
| `--fast` | Skip the animated splash screen |
| `--no-color` | Disable colors |
| `--ascii` | Use ASCII-only symbols (for terminals without good Unicode) |
| `-v`, `--version` | Show the version |
| `-h`, `--help` | Show help |

## Environment variables

| Variable | Purpose |
|---|---|
| `GITHUB_TOKEN` (or `GH_TOKEN`) | Optional. Raises the API limit from 60 to 5,000 requests per hour |
| `GITPROBE_OUT_DIR` | Folder where reports and saved READMEs are written |
| `GITPROBE_FAST=1` | Same as `--fast` |
| `GITPROBE_DEBUG=1` | Show stack traces for unexpected errors |
| `NO_COLOR` | Disable colors (standard convention) |

### Using a token (optional)

```bash
export GITHUB_TOKEN=your_token_here
node probe.js
```

A token with no scopes is enough for public data. GitProbe reads the token only from the environment. It is never printed, saved to disk, or included in reports.

---

## What GitProbe does not do

- **Pinned repositories:** GitHub's REST API does not expose them, so "featured repositories" means the most-starred ones.
- **Watchers:** GitHub's legacy `watchers_count` equals stars, so GitProbe shows the real subscriber count instead.
- **Open issues:** GitHub counts open pull requests together with open issues; GitProbe says so on screen.
- **Star history, contribution graphs, private activity:** not available through the public API, so GitProbe does not show or invent them.
- **Large accounts:** the repository list is loaded in pages and capped at 3,000 repositories as a safety limit. Totals for bigger accounts are marked partial.
- **Scraping:** GitProbe never scrapes web pages; it only uses the GitHub REST API.

Responses are cached in memory for 5 minutes. Use **Refresh data** on the profile screen to fetch fresh data.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `SyntaxError: Unexpected end of input` | `probe.js` was cut off during transfer. Download or copy it again and run `node --check probe.js` |
| `Cannot reach api.github.com` | Check your internet connection, VPN, firewall or DNS, then try again |
| `GitHub API rate limit reached` | Wait until the reset time shown on screen, or set `GITHUB_TOKEN` |
| `GitHub rejected the access token` | The token is invalid or expired. Unset it (`unset GITHUB_TOKEN`) or use a new one |
| `User ... was not found` / `Repository ... was not found` | Check the spelling. Private repositories cannot be read without access |
| The request timed out | The connection is slow. Try again; the timeout is 20 seconds |
| Strange characters like `[38;2;...` on screen | The terminal does not support ANSI colors. Run `node probe.js --no-color --ascii` |
| Boxes or the logo look broken | Use a UTF-8 terminal and a monospaced font, or run with `--ascii` |
| `probe: command not found` | Run `node probe.js --install`, then `hash -r` or reopen the terminal. On Ubuntu as a normal user, add `~/.local/bin` to PATH when asked |
| `A different "probe" command already exists` | Another program already uses that name. GitProbe will not overwrite it. Use `node probe.js` or an alias |
| Reports are not where you expect | They are saved in the folder you ran GitProbe from, or in `GITPROBE_OUT_DIR` |

Press **Ctrl+C** at any time. GitProbe stops animations, restores the cursor and colors, and exits cleanly.

---

## Project structure

```
probe.js     the entire program
README.md    this file
```

---

Made by: **NullKat** · NullKat Development
