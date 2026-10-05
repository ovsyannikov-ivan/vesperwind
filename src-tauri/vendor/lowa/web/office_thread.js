// SPDX-License-Identifier: MIT
// Adapted from allotropia/zetajs convertpdf at b3dec98af5dc4c059a260afd6db0bf0fe38c6384.
// Copyright (c) 2024 allotropia software GmbH and contributors.
import { ZetaHelperThread } from './vendor/zetaHelper.js'
const helper = new ZetaHelperThread(), z = helper.zetajs, css = helper.css
const property = (Name, Value) => new css.beans.PropertyValue({ Name, Value })
const abortInteractions = z.unoObject(['com.sun.star.task.XInteractionHandler'], {
  handle(request) {
    for (const continuation of request.getContinuations()) {
      try { const abort = css.task.XInteractionAbort.query(continuation); if (abort) abort.select() } catch {}
    }
  },
})
let model
helper.thrPort.onmessage = ({ data: request }) => {
  if (request.cmd !== 'convert') return
  try {
    if (model) model.close(false)
    const presentation = /\.pptx$/i.test(request.from)
    // Direct XLoadable model creation is required by the custom headless build.
    model = helper.context.getServiceManager().createInstanceWithContext(presentation
      ? 'com.sun.star.presentation.PresentationDocument' : 'com.sun.star.text.TextDocument', helper.context)
    const filter = presentation ? 'Impress MS PowerPoint 2007 XML'
      : /\.rtf$/i.test(request.from) ? 'Rich Text Format' : 'MS Word 97'
    model.load([
      property('URL', `file://${request.from}`), property('FilterName', filter),
      property('Hidden', true), property('ReadOnly', true),
      // UNO short constants: NEVER_EXECUTE = 0, NO_UPDATE = 0.
      property('MacroExecutionMode', new z.Any(z.type.short, 0)),
      property('UpdateDocMode', new z.Any(z.type.short, 0)),
      property('InteractionHandler', abortInteractions),
    ])
    model.storeToURL(`file://${request.to}`, [property('Overwrite', true),
      property('FilterName', request.target === 'docx' ? 'Office Open XML Text' : 'impress_pdf_Export')])
    helper.thrPort.postMessage({ cmd: 'converted', id: request.id })
  } catch (error) {
    let message = String(error)
    try { message = String(z.catchUnoException(error).Message) } catch {}
    helper.thrPort.postMessage({ cmd: 'error', id: request.id, message })
  }
}
helper.thrPort.postMessage({ cmd: 'ready' })
