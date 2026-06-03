# Architect Doom First-Run Recommended Download Consent

> Require explicit user approval before the standalone Architect Doom tab downloads the recommended official js-dos Digger demo fixture into daemon instance storage, then remount the tab after verified acquisition.

**ID:** `architect_doom_first_run_download_consent`  
**Category:** composite  
**Status:** active  

## Data Contract

### Inputs

| Name | Type | Required | Description |
|------|------|----------|-------------|
| approval | `boolean` | ✅ | Explicit user approval sent as approved=true to the daemon acquisition endpoint. |
| recommended_source | `url` | ✅ | Pinned official js-dos Digger example bundle source URL. |

### Outputs

| Name | Type | Trigger | Description |
|------|------|---------|-------------|
| daemon_cached_bundle | `local_daemon_url` | verified acquisition | Verified local daemon URL for the cached recommended fixture. |
| remounted_doom_panel | `ui_state` | successful acquisition | Active Doom panel remounted after successful acquisition. |

## Interactions

- **show_consent_card** — Show consent card with recommended source URL and approval button.
- **acquire_and_remount** — POST explicit approval to daemon acquisition route and remount the active Doom panel after verified acquisition.
- **use_browser_local_bundle** — Use browser-selected .jsdos bundle locally without daemon upload.

## Visual Semantics

- **Role:** first-start consent card
- **Emphasis:** info
- **Density:** comfortable
- **Chrome:** panel

## Layout Semantics

- **Pattern:** stack
- **Alignment:** leading
- **Sizing behavior:** fill_parent

**Tags:** standalone-architect, doom-tab, first-start, consent, daemon-storage, js-dos
