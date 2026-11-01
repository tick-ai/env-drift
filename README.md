# envdrift: which environment variables does the code read that `.env.example` does not list?

Our services read `process.env` all over the code, and `.env.example` drifts away from
what the code really reads: a variable is added in code and never written down, or one stays
listed for years after the code stopped reading it. This job is to build a small command line
tool that finds both kinds of drift.

## What to create

Create exactly one file, `envdrift.mjs`, at the root of this repository. It is an ES module
for **Node 22**, using only Node's built-in modules. Nothing is installed, there is no
`package.json`, and nothing uses the network. It is run as

    node envdrift.mjs <project-folder>

(from any working directory; `<project-folder>` is absolute or relative to the working
directory, with or without a trailing slash, and may be `.`).

**The territory.** Only `envdrift.mjs` may be created or changed. Do not touch `README.md`
or anything else. (The checks put their own folder `sealed/` beside your file when they run;
you cannot read it.)

## What it does

1. It reads the JavaScript and TypeScript sources under `<project-folder>` and collects the
   set of environment variable names the code reads (rules below).
2. It reads `<project-folder>/.env.example` and collects the set of names that file lists.
3. It compares the two sets (names are case-sensitive) and reports what is **missing**
   (read by the code, not listed in the file) and what is **stale** (listed in the file, not
   read by the code).

### Exit codes and output

| Situation | Exit code | stdout | stderr |
|---|---|---|---|
| the two sets are equal | `0` | one line: `in sync: N` | empty |
| the sets differ | `1` | one line per difference, see below | empty |
| the tool cannot do the job | `2` | empty | one line starting with `envdrift: ` saying why |

`N` is the number of names in the (equal) sets, written in decimal: `in sync: 0`,
`in sync: 12`.

When the sets differ, stdout holds first one line `missing: NAME` for every missing name,
then one line `stale: NAME` for every stale name. Within each group the names are in
ascending order of plain character codes (ASCII order: digits, then upper-case letters, then
`_`, then lower-case letters). Every line ends with a single `\n`. Nothing else is printed.

The tool cannot do the job (exit `2`) when: it is given no argument or more than one; the
argument starts with `-`; the argument does not name an existing folder; the folder has no
file named `.env.example` directly in it (or that name is not a regular file); or a folder
or a source file under it cannot be read. The tool never changes, creates or deletes
anything in the project folder.

### Which files are scanned

* Every file below `<project-folder>`, at any depth, whose name ends in one of
  `.js` `.mjs` `.cjs` `.jsx` `.ts` `.mts` `.cts` `.tsx` (lower-case, exact). Files with any
  other ending (`.json`, `.md`, `.py`, `.JS`, no ending, and so on) are not scanned.
* Folders named exactly `node_modules`, `.git`, `dist` or `build` are skipped entirely, at
  any depth (the match is on the folder's own name, case-sensitive: `Dist`, `builder` and
  `distro` are scanned; a *file* called `build.js` is scanned). The names are checked only on
  folders *below* `<project-folder>`; the folder you pass in is always scanned, whatever it is
  called.
* All other folders are scanned, including ones whose name starts with a dot (such as
  `.github`).
* Symbolic links are ignored: a link to a file is not scanned and a link to a folder is not
  entered.
* Files are decoded as UTF-8. `.env.example` itself is never scanned as source, and only the
  one directly in `<project-folder>` is read; a `.env.example` deeper down is ignored.

### How a source file is read

The source is not parsed as a full language; it is cut into tokens with these rules.

* A first line beginning with `#!` is ignored.
* **Comments** are `//` to the end of the line and `/* ... */`. Nothing inside a comment
  counts. An unterminated block comment runs to the end of the file.
* **Strings** `'...'` and `"..."` end at the first unescaped matching quote (a backslash
  escapes the next character) or at the end of the line, if there is no quote on the line.
  Nothing inside a string counts.
* **Template literals** `` `...` `` ended by the first unescaped backtick: the text parts count
  for nothing, but code inside a `${ ... }` **does** count, to any depth of nesting (a template
  literal inside a `${ }` inside a template literal, and so on). In the text parts a backslash
  escapes the next character (so an escaped backtick and `\${` are plain text). An unterminated
  template runs to the end of the file.
* **Regular-expression literals** are also skipped, and a `/` that is not the start of a
  comment starts one when the previous token (comments ignored) is: nothing at all (start of
  file), or any punctuation except `)` `]` `}`, or one of the words `return` `typeof`
  `instanceof` `in` `of` `new` `delete` `void` `throw` `case` `do` `else` `yield` `await`.
  After any other word, number, string, template, `)`, `]` or `}` the `/` is a division. A
  regular expression ends at the first `/` that is neither escaped by a backslash nor inside a
  `[...]` class (or at the end of the line), followed by its flag letters.
* Whitespace, line breaks and comments may appear between the tokens of any form below.

The code **reads variable `NAME`** when it contains one of these forms. `process` must stand
alone: it must not be part of a longer word and must not come right after a `.` or `?.`
(`xprocess.env.A` and `obj.process.env.A` do not count). `NAME` is a name made of letters,
digits and underscores that does not start with a digit; anything else found in those places
(`process.env["a-b"]`, `process.env.$x`, a string containing an escape) is ignored.

1. **Dot**: `process.env.NAME`, also written `process?.env.NAME`, `process.env?.NAME`,
   `process?.env?.NAME`.
2. **Bracket with a plain string**: `process.env["NAME"]`, `process.env['NAME']` or
   ``process.env[`NAME`]`` (a template without `${`), also `process.env?.["NAME"]`.
   Spaces inside the brackets do not matter. A bracket holding anything else
   (`process.env[key]`, `process.env["A" + b]`, a template with `${`) names nothing.
3. **Destructuring**: an object pattern `{ ... }` immediately followed by a single `=` and
   then `process.env` (or `process?.env`), where `process.env` is **not** followed by `.`,
   `?.` or `[`. This covers `const { A, B } = process.env;`, `let`/`var`, an assignment
   `({ A } = process.env)`, a default parameter `function f({ A } = process.env) {}`, and
   `const { A } = process.env || {}`. Each entry of the pattern, split at its top-level
   commas (commas inside parentheses, brackets, braces, strings and comments do not split),
   reads the name of its key: `A`, `A: alias`, `A = default`, `A: alias = default`, and a
   quoted key `"A": alias` or `'A': alias`. An entry starting with `...` (rest) or with `[`
   (computed key) names nothing. Defaults may be any code; `process.env.X` inside a default
   counts by form 1.

Every occurrence of these forms counts, whether the value is read, assigned or deleted
(`process.env.A = "x"` reads name `A` for our purposes), and every name counts, including
`NODE_ENV` and `PATH`. A name found many times, or in many files, counts once.
Not recognised, and so not counted: `import.meta.env.X`, `Deno.env`, `Bun.env`,
`globalThis.process.env.X`, `process.env` used as a whole (`Object.keys(process.env)`,
`{ ...process.env }`), a copy of it (`const e = process.env; e.A`), and
`const { A } = process.env.B` (this reads only `B`).

### How `.env.example` is read

The file is decoded as UTF-8; a leading byte-order mark is dropped; lines end with `\n` or
`\r\n`. A line lists a name when, after optional spaces and tabs and an optional `export`
followed by at least one space or tab, it has a name (letters, digits, underscores, not
starting with a digit), then optional spaces and tabs, then `=`. Everything after the `=` is
the value and is ignored (it may be empty, quoted, contain `=` or `#`). Every other line
lists nothing: blank lines, lines whose first non-blank character is `#` (so a commented-out
`# FOO=1` is **not** listed), lines with a name but no `=`, and lines whose name is not a
valid name (`A-B=1`, `1A=1`, `A B=1`). A name listed twice counts once.

## Done means

`node envdrift.mjs <folder>` behaves exactly as above on every project folder, runs in a
second or two on a few thousand files, and works with Node 22 alone and no network. A check
will run it as a child process on many fixture folders, comparing exit code, stdout and
stderr exactly.
