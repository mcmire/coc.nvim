'use strict'
import { Neovim } from '@chemzqm/neovim'
import { Position, Range } from 'vscode-languageserver-types'
import { URI } from 'vscode-uri'
import type { WorkspaceConfiguration } from './configuration/types'
import channels from './core/channels'
import { TextEditor } from './core/editors'
import Terminals from './core/terminals'
import * as ui from './core/ui'
import Cursors from './cursors/index'
import events from './events'
import Dialog, { DialogConfig, DialogPreferences } from './model/dialog'
import { FloatWinConfig } from './model/floatFactory'
import InputBox, { InputOptions, InputPreference } from './model/input'
import Menu, { MenuItem } from './model/menu'
import Notification, { NotificationConfig, NotificationKind, NotificationPreferences, toButtons, toTitles } from './model/notification'
import Picker, { toPickerItems } from './model/picker'
import ProgressNotification, { formatMessage, Progress } from './model/progress'
import QuickPick, { QuickPickConfig } from './model/quickpick'
import StatusLine, { StatusBarItem } from './model/status'
import TerminalModel, { TerminalOptions } from './model/terminal'
import { TreeView, TreeViewOptions } from './tree'
import { Env, FloatConfig, FloatFactory, HighlightDiff, HighlightItem, HighlightItemDef, HighlightItemResult, MenuOption, MessageItem, MsgTypes, OpenTerminalOption, OutputChannel, ProgressOptions, QuickPickItem, QuickPickOptions, ScreenPosition, StatusItemOption, TerminalResult } from './types'
import { defaultValue } from './util'
import { isFalsyOrEmpty } from './util/array'
import { CONFIG_FILE_NAME, floatHighlightGroup, isVim } from './util/constants'
import { parseExtensionName } from './util/extensionRegistry'
import { Mutex } from './util/mutex'
import { fs, path } from './util/node'
import { toNumber } from './util/numbers'
import { equals, toObject } from './util/object'
import { isWindows } from './util/platform'
import { CancellationToken, Emitter, Event } from './util/protocol'
import { toText } from './util/string'
import { Workspace } from './workspace'
let tab_global_id = 3000
export type MessageKind = 'Error' | 'Warning' | 'Info'
export type Item = QuickPickItem | string

export enum MessageLevel {
  More,
  Warning,
  Error
}

function generateTabId(): number {
  return tab_global_id++
}

function convertHighlightItem(item: HighlightItem): HighlightItemDef {
  return [item.hlGroup, item.lnum, item.colStart, item.colEnd, item.combine ? 1 : 0, item.start_incl ? 1 : 0, item.end_incl ? 1 : 0]
}

function isSame(item: HighlightItem, curr: HighlightItemResult): boolean {
  let arr = [item.hlGroup, item.lnum, item.colStart, item.colEnd]
  return equals(arr, curr.slice(0, 4))
}

export class Window {
  public mutex = new Mutex()
  private nvim: Neovim
  private tabIds: number[] = []
  private statusLine: StatusLine | undefined
  private terminalManager: Terminals = new Terminals()
  private readonly _onDidTabClose = new Emitter<number>()
  public readonly onDidTabClose: Event<number> = this._onDidTabClose.event
  public readonly cursors: Cursors
  private workspace: Workspace

  public init(env: Env): void {
    for (let i = 1; i <= env.tabCount; i++) {
      this.tabIds.push(generateTabId())
    }
    events.on('TabNew', (nr: number) => {
      this.tabIds.splice(nr - 1, 0, generateTabId())
    })
    events.on('TabClosed', (nr: number) => {
      let id = this.tabIds[nr - 1]
      this.tabIds.splice(nr - 1, 1)
      if (id) this._onDidTabClose.fire(id)
    })
  }

  public getTabNumber(id: number): number | undefined {
    if (!this.tabIds.includes(id)) return undefined
    return this.tabIds.indexOf(id) + 1
  }

  public getTabId(nr: number): number | undefined {
    return this.tabIds[nr - 1]
  }

  public dispose(): void {
    this.terminalManager.dispose()
    this.statusLine?.dispose()
  }

  public get activeTextEditor(): TextEditor | undefined {
    return this.workspace.editors.activeTextEditor
  }

  public get visibleTextEditors(): TextEditor[] {
    return this.workspace.editors.visibleTextEditors
  }

  public get onDidChangeActiveTextEditor(): Event<TextEditor | undefined> {
    return this.workspace.editors.onDidChangeActiveTextEditor
  }

  public get onDidChangeVisibleTextEditors(): Event<ReadonlyArray<TextEditor>> {
    return this.workspace.editors.onDidChangeVisibleTextEditors
  }

  public get terminals(): ReadonlyArray<TerminalModel> {
    return this.terminalManager.terminals
  }

  public get onDidOpenTerminal(): Event<TerminalModel> {
    return this.terminalManager.onDidOpenTerminal
  }

  public get onDidCloseTerminal(): Event<TerminalModel> {
    return this.terminalManager.onDidCloseTerminal
  }

  public async createTerminal(opts: TerminalOptions): Promise<TerminalModel> {
    return await this.terminalManager.createTerminal(this.nvim, opts)
  }

  /**
   * Create a FloatFactory, user's configurations are respected.
   *
   * @param {FloatWinConfig} conf - Float window configuration
   * @returns {FloatFactory}
   */
  public createFloatFactory(conf: FloatWinConfig): FloatFactory {
    let configuration = this.workspace.initialConfiguration
    let defaults = toObject(configuration.get('floatFactory.floatConfig')) as FloatConfig
    let markdownPreference = this.workspace.configurations.markdownPreference
    return ui.createFloatFactory(this.workspace.nvim, Object.assign({ ...markdownPreference, maxWidth: 80 }, conf), defaults)
  }

  /**
   * Reveal message with message type.
   *
   * @param msg Message text to show.
   * @param messageType Type of message, could be `error` `warning` and `more`, default to `more`
   */
  public showMessage(msg: string, messageType: MsgTypes = 'more'): void {
    let { messageLevel } = this
    let hl: 'Error' | 'MoreMsg' | 'WarningMsg' = 'Error'
    let level = MessageLevel.Error
    switch (messageType) {
      case 'more':
        level = MessageLevel.More
        hl = 'MoreMsg'
        break
      case 'warning':
        level = MessageLevel.Warning
        hl = 'WarningMsg'
        break
    }
    if (level >= messageLevel) {
      ui.showMessage(this.nvim, msg, hl)
    }
  }

  /**
   * Run command in vim terminal for result
   *
   * @param cmd Command to run.
   * @param cwd Cwd of terminal, default to result of |getcwd()|.
   */
  public async runTerminalCommand(cmd: string, cwd?: string, keepfocus = false): Promise<TerminalResult> {
    cwd = cwd || this.workspace.cwd
    return await this.nvim.callAsync('coc#ui#run_terminal', { cmd, cwd, keepfocus: keepfocus ? 1 : 0 }) as TerminalResult
  }

  /**
   * Open terminal window.
   *
   * @param cmd Command to run.
   * @param opts Terminal option.
   * @returns number buffer number of terminal
   */
  public async openTerminal(cmd: string, opts?: OpenTerminalOption): Promise<number> {
    let bufnr = await this.nvim.call('coc#ui#open_terminal', { cmd, ...toObject(opts) })
    return bufnr as number
  }

  /**
   * Show quickpick for single item, use `window.menuPick` for menu at current current position.
   *
   * @deprecated Use 'window.showMenuPicker()' or `window.showQuickPick` instead.
   * @param items Label list.
   * @param placeholder Prompt text, default to 'choose by number'.
   * @returns Index of selected item, or -1 when canceled.
   */
  public async showQuickpick(items: string[], placeholder = 'Choose by number'): Promise<number> {
    return await this.showMenuPicker(items, { title: placeholder, position: 'center' })
  }

  /**
   * Shows a selection list.
   */
  public async showQuickPick(itemsOrItemsPromise: Item[] | Promise<Item[]>, options?: QuickPickOptions, token: CancellationToken = CancellationToken.None): Promise<Item | Item[] | undefined> {
    if (isFalsyOrEmpty(itemsOrItemsPromise)) return undefined
    options = defaultValue(options, {})
    const items = await Promise.resolve(itemsOrItemsPromise)
    let isText = items.some(s => typeof s === 'string')
    return await this.mutex.use(() => {
      return new Promise<Item | Item[] | undefined>((resolve, reject) => {
        if (token.isCancellationRequested) return resolve(undefined)
        let quickpick = new QuickPick<QuickPickItem>(this.nvim, this.dialogPreference)
        quickpick.items = items.map(o => typeof o === 'string' ? { label: o } : o)
        quickpick.title = toText(options.title)
        quickpick.canSelectMany = !!options.canPickMany
        quickpick.matchOnDescription = options.matchOnDescription
        quickpick.onDidFinish(items => {
          if (items == null) return resolve(undefined)
          let arr = isText ? items.map(o => o.label) : items
          if (options.canPickMany) return resolve(arr)
          resolve(arr[0])
        })
        quickpick.show().catch(reject)
      })
    })
  }

  /**
   * Creates a {@link QuickPick} to let the user pick an item or items from a
   * list of items of type T.
   *
   * Note that in many cases the more convenient {@link window.showQuickPick}
   * is easier to use. {@link window.createQuickPick} should be used
   * when {@link window.showQuickPick} does not offer the required flexibility.
   *
   * @return A new {@link QuickPick}.
   */
  public async createQuickPick<T extends QuickPickItem>(config: QuickPickConfig<T> = {}): Promise<QuickPick<T>> {
    return await this.mutex.use(async () => {
      let quickpick = new QuickPick<T>(this.nvim, this.dialogPreference)
      Object.assign(quickpick, config)
      return quickpick
    })
  }

  /**
   * Show menu picker at current cursor position, |inputlist()| is used as fallback.
   *
   * @param items Array of texts.
   * @param option Options for menu.
   * @param token A token that can be used to signal cancellation.
   * @returns Selected index (0 based), -1 when canceled.
   */
  public async showMenuPicker(items: string[] | MenuItem[], option?: MenuOption, token?: CancellationToken): Promise<number> {
    return await this.mutex.use(async () => {
      if (token && token.isCancellationRequested) return -1
      option = option || {}
      if (typeof option === 'string') option = { title: option }
      let menu = new Menu(this.nvim, { items, ...option }, token)
      let promise = new Promise<number>(resolve => {
        menu.onDidClose(selected => {
          events.race(['InputChar'], 20).finally(() => {
            resolve(selected)
          })
        })
      })
      await menu.show(this.dialogPreference)
      return await promise
    })
  }

  /**
   * Open local config file
   */
  public async openLocalConfig(): Promise<void> {
    let fsPath = await this.nvim.call('expand', ['%:p']) as string
    let filetype = await this.nvim.eval('&filetype') as string
    if (!fsPath || !path.isAbsolute(fsPath)) {
      void this.showWarningMessage(`Current buffer doesn't have valid file path.`)
      return
    }
    let folder = this.workspace.getWorkspaceFolder(URI.file(fsPath).toString())
    if (!folder) {
      let c = this.configuration.get<any>('workspace')
      let patterns = defaultValue(c.rootPatterns, []) as string[]
      let ignored = defaultValue(c.ignoredFiletypes, []) as string[]
      let msg: string
      if (ignored.includes(filetype)) msg = `Filetype '${filetype}' is ignored for workspace folder resolve.`
      if (!msg) msg = `Can't resolve this.workspace folder for file '${fsPath}, consider create one of ${patterns.join(', ')} in your project root.'.`
      void this.showWarningMessage(msg)
      return
    }
    let root = URI.parse(folder.uri).fsPath
    let dir = path.join(root, '.vim')
    if (!fs.existsSync(dir)) {
      let res = await this.showPrompt(`Would you like to create folder'${root}/.vim'?`)
      if (!res) return
      fs.mkdirSync(dir)
    }
    let filepath = path.join(dir, CONFIG_FILE_NAME)
    await this.nvim.call('coc#util#open_file', ['edit', filepath])
  }

  /**
   * Prompt user for confirm, a float/popup window would be used when possible,
   * use vim's |confirm()| function as callback.
   *
   * @param title The prompt text.
   * @returns Result of confirm.
   */
  public async showPrompt(title: string): Promise<boolean> {
    return await this.mutex.use(() => {
      return ui.showPrompt(this.nvim, title)
    })
  }

  /**
   * Show dialog window at the center of screen.
   * Note that the dialog would always be closed after button click.
   *
   * @param config Dialog configuration.
   * @returns Dialog or null when dialog can't work.
   */
  public async showDialog(config: DialogConfig): Promise<Dialog | null> {
    return await this.mutex.use(async () => {
      let dialog = new Dialog(this.nvim, config)
      await dialog.show(this.dialogPreference)
      return dialog
    })
  }

  /**
   * Request input from user
   *
   * @param title Title text of prompt window.
   * @param value Default value of input, empty text by default.
   * @param {InputOptions} option for input window
   * @returns {Promise<string>}
   */
  public async requestInput(title: string, value?: string, option?: InputOptions): Promise<string | undefined> {
    let { nvim } = this
    const promptInput = this.configuration.get('coc.preferences.promptInput')
    if (promptInput && this.inputSupported) {
      return await this.mutex.use(async () => {
        let input = new InputBox(nvim, toText(value))
        await input.show(title, Object.assign(this.inputPreference, defaultValue(option, {})))
        return await new Promise<string>(resolve => {
          input.onDidFinish(text => {
            setTimeout(() => {
              resolve(text)
            }, 20)
          })
        })
      })
    } else {
      return await this.mutex.use(async () => {
        let res = await this.workspace.callAsync<string>('input', [title + ': ', toText(value)])
        nvim.command('normal! :<C-u>', true)
        return res
      })
    }
  }

  /**
   * Creates and show a {@link InputBox} to let the user enter some text input.
   *
   * @return A new {@link InputBox}.
   */
  public async createInputBox(title: string, defaultValue: string | undefined, option: InputPreference): Promise<InputBox> {
    let input = new InputBox(this.nvim, toText(defaultValue))
    await input.show(title, Object.assign(this.inputPreference, option))
    return input
  }

  /**
   * Create statusbar item that would be included in `g:coc_status`.
   *
   * @param priority Higher priority item would be shown right.
   * @param option
   * @return A new status bar item.
   */
  public createStatusBarItem(priority = 0, option: StatusItemOption = {}): StatusBarItem {
    if (!this.statusLine) {
      this.statusLine = new StatusLine(this.nvim)
    }
    return this.statusLine.createStatusBarItem(priority, option.progress)
  }

  /**
   * Create a new output channel
   *
   * @param name Unique name of output channel.
   * @returns A new output channel.
   */
  public createOutputChannel(name: string): OutputChannel {
    return channels.create(name, this.nvim)
  }

  /**
   * Reveal buffer of output channel.
   *
   * @param name Name of output channel.
   * @param preserveFocus Preserve window focus when true.
   */
  public showOutputChannel(name: string, preserveFocus?: boolean): void {
    let command = this.configuration.get<string>('workspace.openOutputCommand', 'vs')
    channels.show(name, command, preserveFocus)
  }

  /**
   * Echo lines at the bottom of vim.
   *
   * @param lines Line list.
   * @param truncate Truncate the lines to avoid 'press enter to continue' when true
   */
  public async echoLines(lines: string[], truncate = false): Promise<void> {
    let { nvim } = this
    let cmdHeight = this.workspace.env.cmdheight
    if (lines.length > cmdHeight && truncate) {
      lines = lines.slice(0, cmdHeight)
    }
    let maxLen = this.workspace.env.columns - 12
    lines = lines.map(line => {
      line = line.replace(/\n/g, ' ')
      if (truncate) line = line.slice(0, maxLen)
      return line
    })
    if (truncate && lines.length == cmdHeight) {
      let last = lines[lines.length - 1]
      lines[cmdHeight - 1] = `${last.length >= maxLen ? last.slice(0, -4) : last} ...`
    }
    await nvim.call('coc#ui#echo_lines', [lines])
  }

  /**
   * Get current cursor position (line, character both 0 based).
   *
   * @returns Cursor position.
   */
  public getCursorPosition(): Promise<Position> {
    return ui.getCursorPosition(this.nvim)
  }

  /**
   * Move cursor to position.
   *
   * @param position LSP position.
   */
  public async moveTo(position: Position): Promise<void> {
    await ui.moveTo(this.nvim, position, this.workspace.env.isVim)
  }

  /**
   * Get selected range for current document
   */
  public getSelectedRange(mode: string): Promise<Range | null> {
    return ui.getSelection(this.nvim, mode)
  }

  /**
   * Visual select range of current document
   */
  public async selectRange(range: Range): Promise<void> {
    await ui.selectRange(this.nvim, range, this.nvim.isVim)
  }

  /**
   * Get current cursor character offset in document,
   * length of line break would always be 1.
   *
   * @returns Character offset.
   */
  public getOffset(): Promise<number> {
    return ui.getOffset(this.nvim)
  }

  /**
   * Get screen position of current cursor(relative to editor),
   * both `row` and `col` are 0 based.
   *
   * @returns Cursor screen position.
   */
  public getCursorScreenPosition(): Promise<ScreenPosition> {
    return ui.getCursorScreenPosition(this.nvim)
  }

  /**
   * Show multiple picker at center of screen.
   * Use `this.workspace.env.dialog` to check if dialog could work.
   *
   * @param items Array of QuickPickItem or string.
   * @param title Title of picker dialog.
   * @param token A token that can be used to signal cancellation.
   * @return A promise that resolves to the selected items or `undefined`.
   */
  public async showPickerDialog(items: string[], title: string, token?: CancellationToken): Promise<string[] | undefined>
  public async showPickerDialog<T extends QuickPickItem>(items: T[], title: string, token?: CancellationToken): Promise<T[] | undefined>
  public async showPickerDialog(items: any, title: string, token?: CancellationToken): Promise<any | undefined> {
    return await this.mutex.use(async () => {
      if (token && token.isCancellationRequested) {
        return undefined
      }
      const picker = new Picker(this.nvim, {
        title,
        items: toPickerItems(items),
      }, token)
      let promise = new Promise<number[]>(resolve => {
        picker.onDidClose(selected => {
          resolve(selected)
        })
      })
      await picker.show(this.dialogPreference)
      let picked = await promise
      return picked == undefined ? undefined : items.filter((_, i) => picked.includes(i))
    })
  }

  /**
   * Show an information message to users. Optionally provide an array of items which will be presented as
   * clickable buttons.
   *
   * @param message The message to show.
   * @param items A set of items that will be rendered as actions in the message.
   * @return Promise that resolves to the selected item or `undefined` when being dismissed.
   */
  public async showInformationMessage<T extends MessageItem | string>(message: string, ...items: T[]): Promise<T | undefined> {
    let stack = Error().stack
    return await this._showMessage('Info', message, items, stack)
  }

  /**
   * Show an warning message to users. Optionally provide an array of items which will be presented as
   * clickable buttons.
   *
   * @param message The message to show.
   * @param items A set of items that will be rendered as actions in the message.
   * @return Promise that resolves to the selected item or `undefined` when being dismissed.
   */
  public async showWarningMessage<T extends MessageItem | string>(message: string, ...items: T[]): Promise<T | undefined> {
    let stack = Error().stack
    return await this._showMessage('Warning', message, items, stack)
  }

  /**
   * Show an error message to users. Optionally provide an array of items which will be presented as
   * clickable buttons.
   *
   * @param message The message to show.
   * @param items A set of items that will be rendered as actions in the message.
   * @return Promise that resolves to the selected item or `undefined` when being dismissed.
   */
  public async showErrorMessage<T extends MessageItem | string>(message: string, ...items: T[]): Promise<T | undefined> {
    if (!this.workspace) return
    let stack = Error().stack
    return await this._showMessage('Error', message, items, stack)
  }

  private async showMessagePicker<T extends MessageItem | string>(title: string, content: string, hlGroup: string, items: T[]): Promise<T | undefined> {
    let texts = items.map(o => typeof o === 'string' ? o : o.title)
    let res = await this.showMenuPicker(texts, {
      position: 'center',
      content,
      title: title.replace(/\r?\n/, ' '),
      borderhighlight: hlGroup
    })
    return items[res]
  }

  private async _showMessage<T extends MessageItem | string>(kind: MessageKind, message: string, items: T[], stack: string): Promise<T | undefined> {
    if (!this.enableMessageDialog) return await this.showConfirm(message, items, kind) as any
    if (items.length > 0) {
      let source = parseExtensionName(stack)
      return await this.showMessagePicker(`Choose action (${source})`, message, `Coc${kind}Float`, items)
    }
    await this.createNotification(kind.toLowerCase() as NotificationKind, message, [], stack)
    return undefined
  }

  public async showNotification(config: NotificationConfig): Promise<void> {
    let stack = Error().stack
    let notification = new Notification(this.nvim, config)
    await notification.show(this.getNotificationPreference(stack))
  }

  // fallback for vim without dialog
  private async showConfirm<T extends MessageItem | string>(message: string, items: T[], kind: MessageKind): Promise<T> {
    if (!items || items.length == 0) {
      let msgType: MsgTypes = kind == 'Info' ? 'more' : kind == 'Error' ? 'error' : 'warning'
      this.showMessage(message, msgType)
      return undefined
    }
    let titles = toTitles(items)
    let choices = titles.map((s, i) => `${i + 1}${s}`)
    let res = await this.nvim.callAsync('coc#util#with_callback', ['confirm', [message, choices.join('\n'), 0, kind]]) as number
    return items[res - 1]
  }

  /**
   * Show progress in the editor. Progress is shown while running the given callback
   * and while the promise it returned isn't resolved nor rejected.
   */
  public async withProgress<R>(options: ProgressOptions, task: (progress: Progress, token: CancellationToken) => Thenable<R>): Promise<R> {
    let config = this.configuration.get<any>('notification')

    let stack = Error().stack
    if (config.statusLineProgress) {
      return await this.createStatusLineProgress(options, task)
    }
    let progress = new ProgressNotification(this.nvim, {
      task,
      title: options.title,
      cancellable: options.cancellable
    })
    let minWidth = toNumber(config.minProgressWidth, 30)
    let promise = new Promise<R>(resolve => {
      progress.onDidFinish(resolve)
    })
    await progress.show(Object.assign(this.getNotificationPreference(stack, options.source), { minWidth }))
    return await promise
  }

  private async createStatusLineProgress<R>(options: ProgressOptions, task: (progress: Progress, token: CancellationToken) => Thenable<R>): Promise<R> {
    let { title } = options
    let statusItem = this.createStatusBarItem(0, { progress: true })
    statusItem.text = toText(title)
    statusItem.show()
    let total = 0
    let result = await task({
      report: p => {
        if (p.increment) {
          total += p.increment
        }
        statusItem.text = formatMessage(title, p.message, total)
      }
    }, CancellationToken.None)
    statusItem.dispose()
    return result
  }

  /**
   * Create a {@link TreeView} instance.
   *
   * @param viewId Id of the view, used as title of TreeView when title doesn't exist.
   * @param options Options for creating the {@link TreeView}
   * @returns a {@link TreeView}.
   */
  public createTreeView<T>(viewId: string, options: TreeViewOptions<T>): TreeView<T> {
    const BasicTreeView = require('./tree/TreeView').default
    return new BasicTreeView(viewId, options)
  }

  /**
   * Get diff from highlight items and current highlights on vim.
   * Return null when buffer not loaded
   *
   * @param bufnr Buffer number
   * @param ns Highlight namespace
   * @param items Highlight items
   * @param region 0 based start and end line count (end exclusive)
   * @param token CancellationToken
   * @returns {Promise<HighlightDiff | null>}
   */
  public async diffHighlights(bufnr: number, ns: string, items: HighlightItem[], region?: [number, number] | undefined, token?: CancellationToken): Promise<HighlightDiff | null> {
    let args = [bufnr, ns]
    if (Array.isArray(region)) args.push(region[0], region[1] - 1)
    let curr = await this.nvim.call('coc#highlight#get_highlights', args) as HighlightItemResult[]
    if (!curr || token?.isCancellationRequested) return null
    items.sort((a, b) => a.lnum - b.lnum)
    let linesToRemove = []
    let checkMarkers = this.workspace.has('nvim-0.5.1') || this.workspace.isVim
    let removeMarkers = []
    let newItems: HighlightItemDef[] = []
    let itemIndex = 0
    let maxIndex = items.length - 1
    let maxLnum = 0
    // highlights on vim
    let map: Map<number, HighlightItemResult[]> = new Map()
    curr.forEach(o => {
      maxLnum = Math.max(maxLnum, o[1])
      let arr = map.get(o[1])
      if (arr) {
        arr.push(o)
      } else {
        map.set(o[1], [o])
      }
    })
    if (curr.length > 0) {
      let start = Array.isArray(region) ? region[0] : 0
      for (let i = start; i <= maxLnum; i++) {
        let exists = defaultValue(map.get(i), [])
        let added: HighlightItem[] = []
        for (let j = itemIndex; j <= maxIndex; j++) {
          let o = items[j]
          if (o.lnum == i) {
            itemIndex = j + 1
            added.push(o)
          } else {
            itemIndex = j
            break
          }
        }
        if (added.length == 0) {
          if (exists.length > 0) {
            if (checkMarkers) {
              removeMarkers.push(...exists.map(o => o[4]))
            } else {
              linesToRemove.push(i)
            }
          }
        } else {
          if (exists.length == 0) {
            newItems.push(...added.map(o => convertHighlightItem(o)))
          } else {
            if (checkMarkers) {
              // skip same markers at beginning of exists and removeMarkers
              let skip = 0
              let min = Math.min(exists.length, added.length)
              while (skip < min) {
                if (isSame(added[skip], exists[skip])) {
                  skip++
                } else {
                  break
                }
              }
              removeMarkers.push(...exists.slice(skip).map(o => o[4]))
              newItems.push(...added.slice(skip).map(o => convertHighlightItem(o)))
            } else if (added.length != exists.length || !(added.every((o, i) => isSame(o, exists[i])))) {
              linesToRemove.push(i)
              newItems.push(...added.map(o => convertHighlightItem(o)))
            }
          }
        }
      }
    }
    for (let i = itemIndex; i <= maxIndex; i++) {
      newItems.push(convertHighlightItem(items[i]))
    }
    return { remove: linesToRemove, add: newItems, removeMarkers }
  }

  /**
   * Apply highlight diffs, normally used with `window.diffHighlights`
   *
   * Timer is used to add highlights when there're too many highlight items to add,
   * the highlight process won't be finished on that case.
   *
   * @param {number} bufnr - Buffer name
   * @param {string} ns - Namespace
   * @param {number} priority
   * @param {HighlightDiff} diff
   * @param {boolean} notify - Use notification, default false.
   * @returns {Promise<void>}
   */
  public async applyDiffHighlights(bufnr: number, ns: string, priority: number, diff: HighlightDiff, notify = false): Promise<void> {
    let { nvim } = this
    let { remove, add, removeMarkers } = diff
    if (remove.length === 0 && add.length === 0 && removeMarkers.length === 0) return
    nvim.pauseNotification()
    if (removeMarkers.length) {
      nvim.call('coc#highlight#del_markers', [bufnr, ns, removeMarkers], true)
    }
    if (remove.length) {
      nvim.call('coc#highlight#clear', [bufnr, ns, remove], true)
    }
    if (add.length) {
      nvim.call('coc#highlight#set', [bufnr, ns, add, priority], true)
    }
    if (notify) {
      nvim.resumeNotification(true, true)
    } else {
      await nvim.resumeNotification(true)
    }
  }

  public createNotification(kind: NotificationKind, message: string, items: string[], stack: string): Promise<number> {
    return new Promise((resolve, reject) => {
      let config: NotificationConfig = {
        kind,
        content: message,
        buttons: toButtons(items),
        callback: idx => {
          resolve(idx)
        }
      }
      let notification = new Notification(this.nvim, config)
      notification.show(this.getNotificationPreference(stack)).catch(reject)
    })
  }

  private get dialogPreference(): DialogPreferences {
    let config = this.configuration.get<any>('dialog')
    return {
      rounded: !!config.rounded,
      maxWidth: toNumber(config.maxWidth, 80),
      maxHeight: config.maxHeight,
      floatHighlight: defaultValue(config.floatHighlight, floatHighlightGroup),
      floatBorderHighlight: defaultValue(config.floatBorderHighlight, floatHighlightGroup),
      pickerButtons: config.pickerButtons,
      pickerButtonShortcut: config.pickerButtonShortcut,
      confirmKey: toText(config.confirmKey),
      shortcutHighlight: toText(config.shortcutHighlight)
    }
  }

  public get inputSupported(): boolean {
    // TODO support vim9 on windows
    return !isVim || (this.workspace.has('patch-8.2.750') && !isWindows)
  }

  private get inputPreference(): InputPreference {
    let config = this.configuration.get<any>('dialog')
    return {
      rounded: !!config.rounded,
      maxWidth: toNumber(config.maxWidth, 80),
      highlight: defaultValue(config.floatHighlight, floatHighlightGroup),
      borderhighlight: defaultValue(config.floatBorderHighlight, floatHighlightGroup)
    }
  }

  private getNotificationPreference(stack: string, source?: string): NotificationPreferences {
    if (!source) source = parseExtensionName(stack)
    let config = this.configuration.get<any>('notification')

    let disabledList = defaultValue(config.disabledProgressSources, []) as string[]
    let disabled = Array.isArray(disabledList) && (disabledList.includes('*') || disabledList.includes(source))
    return {
      border: config.border,
      focusable: config.focusable,
      marginRight: toNumber(config.marginRight, 10),
      timeout: toNumber(config.timeout, 10000),
      maxWidth: toNumber(config.maxWidth, 60),
      maxHeight: toNumber(config.maxHeight, 10),
      highlight: config.highlightGroup,
      winblend: toNumber(config.winblend, 30),
      disabled,
      source,
    }
  }

  private get configuration(): WorkspaceConfiguration {
    return this.workspace.initialConfiguration
  }

  private get enableMessageDialog(): boolean {
    return this.configuration.get<boolean>('coc.preferences.enableMessageDialog', false)
  }

  public get messageLevel(): MessageLevel {
    let level = this.configuration.get<string>('coc.preferences.messageLevel', 'more')
    switch (level) {
      case 'error':
        return MessageLevel.Error
      case 'warning':
        return MessageLevel.Warning
      default:
        return MessageLevel.More
    }
  }
}

export default new Window()
