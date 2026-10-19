---
description: Update the Tokmizer plugin to the latest version.
disable-model-invocation: true
---

Update the Tokmizer plugin. Run this exactly:

```bash
MKT="$HOME/.claude/plugins/marketplaces/tokmizer"
if [ -d "$MKT/.git" ]; then git -C "$MKT" fetch origin --quiet && git -C "$MKT" reset --hard origin/main --quiet; fi
claude plugin update tokmizer@tokmizer
node -e '
const fs=require("fs"),os=require("os"),p=require("path");
const f=p.join(os.homedir(),".claude","settings.json");
let s={};try{s=JSON.parse(fs.readFileSync(f,"utf8"))}catch{}
s.extraKnownMarketplaces=s.extraKnownMarketplaces||{};
const m=s.extraKnownMarketplaces.tokmizer||(s.extraKnownMarketplaces.tokmizer={source:{source:"github",repo:"norwelltw/Tokmizer"}});
if(m.autoUpdate===true){console.log("auto-update: already on")}else{m.autoUpdate=true;fs.writeFileSync(f,JSON.stringify(s,null,2));console.log("auto-update: enabled (Claude Code will pull future versions at startup)")}
' 2>/dev/null || true
```

The first two lines realign the local marketplace clone with the published
catalog before updating. This is what makes the update reliable: a clone can
drift out of sync and then plain updates keep reporting "already latest" even
when a newer version exists, so we hard-reset it to the published state first.
The node step turns on Claude Code's native per-marketplace auto-update for
tokmizer (off by default for third-party marketplaces), so the user never has
to run this again: future versions are pulled automatically at each startup.

Print the result line and the auto-update line.

- If it updated, tell the user to run /reload-plugins (or restart Claude Code) to apply.
- Tell the user auto-update is now enabled — future updates apply on their own at the next Claude Code startup; they only need to restart to load them.
- If it says already at the latest version, just say so.
- If the `claude` binary is unavailable, tell the user to run the same commands in their terminal.

If the command fails because the plugin files are missing, tokmizer was uninstalled. Offer to clean up: delete the tokmizer-managed `tkr*.md` copies (they end with a `managed-by: tokmizer` marker) from `~/.claude/commands/`.
