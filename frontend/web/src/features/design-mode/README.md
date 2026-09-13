# Shared improved design

Settings > 개선 디자인 controls the presentation for all users of one server.
An administrator can change it; other users can see the current mode.
The `/api/settings/design-mode` endpoint stores `design_mode` in server settings.
The checked-in project settings select `improved`; missing settings fall back to
`classic`. Browser-local design preferences are ignored.

Clients refresh the setting every three seconds and when the window gains focus.
A successful save updates the current screen immediately without remounting the
app or changing its active session, draft, attachments, or theme. Read and save
failures are shown beside the control.

Appearance overrides are scoped under `data-design-mode="improved"`. The shared
composer keeps the same input sizing, actions, and responsive behavior in both
modes. Execution records, errors, approvals, and artifact actions remain available.

## Design contract

Compact controls, a neutral light palette, Korean-aware font fallbacks,
16px conversation text, 14px controls and tables, and 13px supporting labels.
Existing themes retain their semantic colors.

## Removal

Remove the provider wrapper from `components/AppShell.tsx`, the toggle from
`components/SettingsModal.tsx`, this feature directory, and the design-mode
endpoint and settings field together. No conversation-data migration is needed.
