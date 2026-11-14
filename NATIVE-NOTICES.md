# Standalone client notices and rebuilding

The standalone client contains the public ZESIA Runtime (MIT), Bun 1.3.13 and the
unmodified official a2a-cli 0.4.0. It contains no private platform implementation.

- ZESIA source: https://github.com/Rowtion/zesia-skill (exact commit in runtime.json).
- Bun source: https://github.com/oven-sh/bun/tree/bun-v1.3.13 . Its redistribution
  notice is included in licenses/BUN-LICENSE.md, including the statically linked
  JavaScriptCore/WebKit LGPL notice and links/rebuild instructions for patched WebKit.
- Bun's patched WebKit source: https://github.com/oven-sh/webkit ; the exact submodule
  revision is recorded by the Bun source tag. Follow upstream's relinking instructions.
- The emitted zesia-cli.bundle.mjs is supplied with the native asset. Rebuild/relink
  it using your modified Bun: `bun build --compile --no-compile-autoload-dotenv --no-compile-autoload-bunfig zesia-cli.bundle.mjs --outfile scripts/zesia`.
  On Windows use scripts/zesia.exe. Apply ordinary build-time ad-hoc signing on macOS.
  This does not require changing user system security settings.
- a2a-cli source: https://github.com/a2aproject/a2a-cli/tree/v0.4.0 ; its original
  license is retained as bin/A2A-CLI-LICENSE. Native archive/binary checksums are recorded.

Only public source and a non-secret bundled entry point are provided. Neither a trial token,
model key, conversation nor local user state belongs in these assets. Preserve these notices
and upstream licensing when modifying or redistributing the standalone bundle.
