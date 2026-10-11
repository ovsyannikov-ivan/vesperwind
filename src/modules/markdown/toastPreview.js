// ToastMark re-parses paragraphs that use reference definitions and reports them
// as extra edits. TOAST UI 3.2.2 inserts such an edit at the top of the preview
// when it has no previous range, duplicating the paragraph. The preview is
// re-rendered from the parsed document whenever an update carries extra edits.
export const renderWholePreview = ({ preview, toastMark }) => {
  preview.setHTML(preview.sanitizer(preview.getRenderer().render(toastMark.getRootNode())))
}

export const installPreviewRepair = (instance) => {
  instance.eventEmitter.listen('updatePreview', (changed) => {
    if (changed.length > 1) renderWholePreview(instance)
  })
}
