#!/bin/bash
# ai-terminal setup — registers the Stop hook in Claude Code settings
#
# Usage: ./scripts/setup.sh
#
# This adds the ai-terminal hook to ~/.claude/settings.json so that
# Claude Code reports session IDs and logs history after every exchange.

set -e

SETTINGS="$HOME/.claude/settings.json"
HOOK_SCRIPT="$(cd "$(dirname "$0")" && pwd)/session-bridge.js"

if [ ! -f "$SETTINGS" ]; then
  echo "Creating $SETTINGS..."
  mkdir -p "$(dirname "$SETTINGS")"
  echo '{"hooks":{"Stop":[{"matcher":"","hooks":[]}]}}' > "$SETTINGS"
fi

# Check if hook is already registered
if grep -q "ai-terminal" "$SETTINGS" 2>/dev/null; then
  echo "ai-terminal hook already registered in $SETTINGS"
  exit 0
fi

echo ""
echo "ai-terminal needs to add a Stop hook to your Claude Code settings."
echo "This hook runs after every Claude response to:"
echo "  - Report the session ID to the app (for tab naming)"
echo "  - Log the exchange to local history (for the session browser)"
echo ""
echo "Hook script: $HOOK_SCRIPT"
echo "Settings file: $SETTINGS"
echo ""
read -p "Add the hook? [Y/n] " -n 1 -r
echo ""

if [[ $REPLY =~ ^[Nn]$ ]]; then
  echo "Skipped. You can add it manually later."
  exit 0
fi

# Use node to safely modify the JSON
node -e "
const fs = require('fs');
const settings = JSON.parse(fs.readFileSync('$SETTINGS', 'utf-8'));

if (!settings.hooks) settings.hooks = {};
if (!settings.hooks.Stop) settings.hooks.Stop = [{ matcher: '', hooks: [] }];

const stopHooks = settings.hooks.Stop[0].hooks;
const already = stopHooks.some(h => h.command && h.command.includes('ai-terminal'));

if (!already) {
  stopHooks.push({
    type: 'command',
    command: 'node $HOOK_SCRIPT'
  });
  fs.writeFileSync('$SETTINGS', JSON.stringify(settings, null, 2));
  console.log('Hook added successfully.');
} else {
  console.log('Hook already present.');
}
"

echo "Done. Start ai-terminal with: npm start"
