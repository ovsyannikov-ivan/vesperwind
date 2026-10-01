# Vesperwind project conventions

## Consistent modal styling

All modals must follow the existing compact Bootstrap style. Before adding or
changing a dialog, compare it with `src/components/FileOperationConfirmModal.vue`
and `src/components/SettingsModal.vue`; do not introduce a separate visual style.

- Use `h1.modal-title.fs-6.d-flex.align-items-center.gap-2` for the heading,
  with a relevant decorative MDI icon (`aria-hidden="true"`). The heading's
  semantic level must not make its visual size larger.
- Use `btn btn-sm` plus the appropriate variant for every footer button:
  primary action `btn-primary`, destructive action `btn-danger` (never
  `btn-outline-danger`), and Cancel or any other neutral action the shared
  `btn-neutral` style from `src/styles/main.css`. Settings may retain its
  secondary outline reset action.

## Consistent button styling

- Neutral actions in dialogs, menus, and panels (Cancel, Clear, Close, a
  secondary Save or Add) use `btn btn-sm btn-neutral`: the toolbar command
  surface with a subtle lighter border. Do not use Bootstrap `btn-secondary` for
  them; it is too heavy for the Vesperwind UI. Use it only with a deliberate,
  documented reason.
- Dense sidebar and header controls use `compact-icon-button`, or
  `compact-button` when they need a text label, so they share its 24px height.
- Reuse these shared styles instead of restyling the same kind of action in a
  component. Extend the shared rule when a new state is needed.
- Use compact form controls (`form-control-sm` / `form-select-sm`), standard
  `form-label` labels, and existing Bootstrap spacing and theme variables.
- Keep the standard `modal-header`, `modal-body`, and `modal-footer` structure.
  Use `btn-close` for close controls and connect the title/description with ARIA.
- Media viewers may keep their specialized content layout and fullscreen controls,
  but their header typography and icon alignment follow the same convention.
- Verify affected dialogs visually and run `npm test` before handing off changes.
  The modal-style regression test should cover any new modal component.

## Consistent dropdown styling

Use the shared `src/styles/dropdown.css` and Bootstrap `dropdown-menu` / `dropdown-item`
classes for new dropdowns. Compare their appearance with the file context menu.
Keep padding, rounded items, icon alignment, and hover, active, and keyboard focus
states consistent. Use `var(--bs-primary)` with white text for highlighted items.
Menus keep the shared surface (background, border, 12px menu and 8px item radius,
shadow) in every window, including the media overlay that does not load
`main.css`; do not use `dropdown-menu-dark` or per-menu background/radius overrides.
Opening a menu must not highlight its first item until the pointer hovers over it
or keyboard navigation selects it. Use normal title or sentence case for menu
labels and headings; avoid all caps except established acronyms.

## Communication style

When communicating with the user in Russian, refer to yourself using
feminine grammatical gender.

Examples:

- "реализовала", not "реализовал"
- "проверила", not "проверил"
- "добавила", not "добавил"
- "исправила", not "исправил"

Address the user in masculine grammatical gender.

This applies to progress updates, final reports, explanations, and
conversational responses. It does not affect code, commit messages,
documentation, or technical terminology.
