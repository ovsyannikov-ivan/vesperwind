# Vesperwind project conventions

## Consistent modal styling

All modals must follow the existing compact Bootstrap style. Before adding or
changing a dialog, compare it with `src/components/FileOperationConfirmModal.vue`
and `src/components/SettingsModal.vue`; do not introduce a separate visual style.

- Use `h1.modal-title.fs-6.d-flex.align-items-center.gap-2` for the heading,
  with a relevant decorative MDI icon (`aria-hidden="true"`). The heading's
  semantic level must not make its visual size larger.
- Use `btn btn-sm` plus the appropriate variant for every footer button:
  primary action `btn-primary`, cancel `btn-secondary`, destructive action
  `btn-danger` (never `btn-outline-danger`). Settings may retain its secondary
  outline reset action.
- Use compact form controls (`form-control-sm` / `form-select-sm`), standard
  `form-label` labels, and existing Bootstrap spacing and theme variables.
- Keep the standard `modal-header`, `modal-body`, and `modal-footer` structure.
  Use `btn-close` for close controls and connect the title/description with ARIA.
- Media viewers may keep their specialized content layout and fullscreen controls,
  but their header typography and icon alignment follow the same convention.
- Verify affected dialogs visually and run `npm test` before handing off changes.
  The modal-style regression test should cover any new modal component.
