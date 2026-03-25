# Contributing to Helix ADK

## Local development with helix-claw

If you're developing both repos simultaneously, use Bun workspaces
or local overrides instead of git dependencies:

1. Clone both repos into the same parent directory:
   git clone git@github.com:SteveEmmerich/helix-adk.git
   git clone git@github.com:SteveEmmerich/helix-claw.git

2. In helix-claw, temporarily replace github deps with local paths:
   "@helix/core": "../helix-adk/packages/core"

   Or use bun link:
   cd helix-adk/packages/core && bun link
   cd helix-claw && bun link @helix/core

3. Run tests:
   cd helix-adk && bun test
   cd helix-claw && bun test

## Publishing to npm (when ready)

When ready to publish @helix/* packages:
  cd helix-adk
  bun run build
  npm publish packages/ai --access public
  npm publish packages/core --access public
  [etc for each package]

Then update helix-claw dependencies from:
  "github:SteveEmmerich/helix-adk#main"
To:
  "^0.1.0"
