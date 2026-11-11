# Zesia public client development

Start every task with Git status and preserve existing changes. This is a public client repository: never include model keys, tokens, conversations, runtime state or private platform code/history. Keep upstream notices and existing licenses.

Use `npm ci --ignore-scripts`, `npm run build --if-present`, `npm test`, `npm run package`. Pin shared client dependencies to immutable versioned release tarballs with lockfile integrity; do not import sibling repositories. Cloud consultation uses A2A. Preserve explicit confirmation, no automatic retries of unknown effects and host permissions. End users must not require administrator privileges or private repository access.

CI tests and packages this repository independently. Release is explicit manual dispatch on main; never overwrite a published version. Local-host smoke tests and real model calls are distinct from offline CI. Record repository boundary decisions and migration state in documentation, without treating plans as implemented features.
