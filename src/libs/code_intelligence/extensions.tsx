import { CommandListPopoverButton } from '@sourcegraph/extensions-client-common/lib/app/CommandList'
import {
    Controller as ClientController,
    createController,
} from '@sourcegraph/extensions-client-common/lib/client/controller'
import { Controller } from '@sourcegraph/extensions-client-common/lib/controller'
import {
    ConfigurationCascade,
    ConfigurationCascadeOrError,
    ConfigurationSubject,
    ConfiguredSubject,
    Settings,
} from '@sourcegraph/extensions-client-common/lib/settings'
import * as React from 'react'
import { render } from 'react-dom'
import { combineLatest, from, Observable } from 'rxjs'
import { map, take } from 'rxjs/operators'
import { TextDocumentItem } from 'sourcegraph/module/client/types/textDocument'
import { ContributableMenu } from 'sourcegraph/module/protocol'
import { TextDocumentDecoration } from 'sourcegraph/module/protocol/plainTypes'
import { Disposable } from 'vscode-languageserver'

import { DOMFunctions } from '@sourcegraph/codeintellify'
import * as H from 'history'
import { isErrorLike } from '../../shared/backend/errors'
import { createExtensionsContextController, createMessageTransports } from '../../shared/backend/extensions'
import { GlobalDebug } from '../../shared/components/GlobalDebug'
import { sourcegraphUrl } from '../../shared/util/context'
import { getGlobalDebugMount } from '../github/extensions'
import { MountGetter } from './code_intelligence'

// This is rather specific to extensions-client-common
// and could be moved to that package in the future.
export function logThenDropConfigurationErrors(
    cascadeOrError: ConfigurationCascadeOrError<ConfigurationSubject, Settings>
): ConfigurationCascade<ConfigurationSubject, Settings> {
    const EMPTY_CASCADE: ConfigurationCascade<ConfigurationSubject, Settings> = {
        subjects: [],
        merged: {},
    }
    if (!cascadeOrError.subjects) {
        console.error('invalid configuration: no configuration subjects available')
        return EMPTY_CASCADE
    }
    if (!cascadeOrError.merged) {
        console.error('invalid configuration: no merged configuration available')
        return EMPTY_CASCADE
    }
    if (isErrorLike(cascadeOrError.subjects)) {
        console.error(`invalid configuration: error in configuration subjects: ${cascadeOrError.subjects.message}`)
        return EMPTY_CASCADE
    }
    if (isErrorLike(cascadeOrError.merged)) {
        console.error(`invalid configuration: error in merged configuration: ${cascadeOrError.merged.message}`)
        return EMPTY_CASCADE
    }
    return {
        subjects: cascadeOrError.subjects.filter(
            (subject): subject is ConfiguredSubject<ConfigurationSubject, Settings> => {
                if (!subject) {
                    console.error('invalid configuration: no configuration subjects available')
                    return false
                }
                if (isErrorLike(subject)) {
                    console.error(`invalid configuration: error in configuration subjects: ${subject.message}`)
                    return false
                }
                return true
            }
        ),
        merged: cascadeOrError.merged,
    }
}

export interface Controllers {
    extensionsContextController: Controller<ConfigurationSubject, Settings>
    extensionsController: ClientController<ConfigurationSubject, Settings>
}

function createControllers(documents: Observable<TextDocumentItem[] | null>): Controllers {
    const extensionsContextController = createExtensionsContextController(sourcegraphUrl)
    const extensionsController = createController(extensionsContextController!.context, createMessageTransports)

    combineLatest(
        extensionsContextController.viewerConfiguredExtensions,
        from(extensionsContextController.context.configurationCascade).pipe(map(logThenDropConfigurationErrors)),
        documents
    ).subscribe(([extensions, configuration, visibleTextDocuments]) => {
        from(extensionsController.environment)
            .pipe(take(1))
            .subscribe(({ context }) => {
                extensionsController.setEnvironment({
                    extensions,
                    configuration,
                    visibleTextDocuments,
                    context,
                })
            })
    })

    return { extensionsContextController, extensionsController }
}

/**
 * Initializes extensions for a page. It creates the controllers and injects the command palette.
 */
export function initializeExtensions(
    getCommandPaletteMount: MountGetter,
    documents: Observable<TextDocumentItem[] | null>
): Controllers {
    const { extensionsContextController, extensionsController } = createControllers(documents)

    render(
        <CommandListPopoverButton
            extensionsController={extensionsController}
            menu={ContributableMenu.CommandPalette}
            extensions={extensionsContextController}
        />,
        getCommandPaletteMount()
    )

    const history = H.createBrowserHistory()
    render(
        <GlobalDebug extensionsController={extensionsController} location={history.location} />,
        getGlobalDebugMount()
    )

    return { extensionsContextController, extensionsController }
}

const mergeDisposables = (...disposables: Disposable[]): Disposable => ({
    dispose: () => {
        for (const disposable of disposables) {
            disposable.dispose()
        }
    },
})

/**
 * Applies a decoration to a code view. This doesn't work with diff views yet.
 */
export const applyDecoration = (
    dom: DOMFunctions,
    {
        codeView,
        decoration,
    }: {
        codeView: HTMLElement
        decoration: TextDocumentDecoration
    }
): Disposable => {
    const disposables: Disposable[] = []

    const lineNumber = decoration.range.start.line + 1
    const codeElement = dom.getCodeElementFromLineNumber(codeView, lineNumber)
    if (!codeElement) {
        throw new Error(`Unable to find code element for line ${lineNumber}`)
    }

    if (decoration.backgroundColor) {
        codeElement.style.backgroundColor = decoration.backgroundColor
        disposables.push({
            dispose: () => {
                codeElement.style.backgroundColor = null
            },
        })
    }

    if (decoration.after) {
        const linkTo = (url: string) => (e: HTMLElement): HTMLElement => {
            const link = document.createElement('a')
            link.setAttribute('href', url)
            link.style.color = decoration.after!.color || null
            link.appendChild(e)
            return link
        }

        const after = document.createElement('span')
        after.style.backgroundColor = decoration.after.backgroundColor || null
        after.textContent = decoration.after.contentText || null

        const annotation = decoration.after.linkURL ? linkTo(decoration.after.linkURL)(after) : after
        codeElement.appendChild(annotation)

        disposables.push({
            dispose: () => {
                annotation.remove()
            },
        })
    }
    return mergeDisposables(...disposables)
}
