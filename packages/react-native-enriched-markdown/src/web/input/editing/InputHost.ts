import { BlockStore, lineAtPosition } from '../formatting/BlockStore';
import { FormattingStore } from '../formatting/FormattingStore';
import { parseToPlainTextAndRanges } from '../formatting/InputParser';
import { serialize } from '../formatting/MarkdownSerializer';
import type { RangeBounds } from '../model/rangeBounds';
import { DomRenderer } from '../render/DomRenderer';
import { computeStyleRuns, projectParagraphs } from '../render/InputProjection';
import { ENRM_INPUT_CLASS, injectInputStyles } from '../render/inputStyles';
import { isListItem, type BlockType } from '../model/blocks';
import type { PendingStyleType } from '../model/inlineStyles';
import { BlockEditCoordinator } from './BlockEditCoordinator';
import { EditPipeline } from './EditPipeline';
import { EditSession } from './EditSession';
import {
  nativeEditLanded,
  planNativeEdit,
  spansMatchRuns,
  type NativeEdit,
} from './NativeEdit';
import { SelectionMapper, type DomPosition } from './SelectionMapper';
import { TypingAttributesController } from './TypingAttributesController';
import { buildInputState, sameInputState, type InputState } from './InputState';
import {
  clamp,
  codePointBoundaryAtOrBefore,
  graphemeLengthBefore,
  graphemeLengthAfter,
  isCodePointBoundary,
  isWhitespace,
} from '../utils';

export interface CaretRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface InputHostCallbacks {
  onChangeText?: (text: string) => void;
  onChangeSelection?: (selection: RangeBounds) => void;
  onChangeState?: (state: InputState) => void;
  onChangeMarkdown?: (markdown: string) => void;
}

export interface InputHostOptions {
  // Left to the browser when unset, which is what native does too: the OS
  // keyboard spellchecks normally there. `false` turns it off, along with the
  // squiggles under anything markdown-ish.
  spellCheck?: boolean;
}

export class InputHost {
  private readonly root: HTMLElement;
  private readonly callbacks: InputHostCallbacks;
  private readonly formattingStore = new FormattingStore();
  private readonly blockStore = new BlockStore();
  private readonly session = new EditSession();
  private readonly pipeline: EditPipeline;
  private readonly blockCoordinator: BlockEditCoordinator;
  private readonly typing: TypingAttributesController;
  private readonly renderer: DomRenderer;
  private readonly mapper: SelectionMapper;
  // Attributes this host set itself, and so the only ones it removes on
  // teardown: `role` and `aria-multiline` are set only when the node does not
  // already carry them, so a consumer's own value is never ours to undo.
  // `data-empty` is listed from the start because `render` toggles it rather
  // than setting it, and teardown has to clear it either way.
  private readonly ownedAttributes: string[] = ['data-empty'];

  private text = '';
  private selection: RangeBounds = { start: 0, end: 0 };
  // Whether the selection runs from `end` back to `start`: the DOM's anchor
  // is the end. Kept beside `selection` rather than in it because the bounds
  // are what every consumer and callback reads.
  private selectionBackward = false;
  // Work that would write the DOM while an IME owns it - commands, imports,
  // imperative selection moves - waits here for the composition to end.
  private deferredUntilCompositionEnd: Array<() => void> = [];
  // A mouse or touch selection in progress. Links snap to whole only once it
  // ends, the way iOS waits for its selection gesture: rewriting the
  // selection under a drag fights the browser for its anchor.
  private pointerSelecting = false;
  // An edit the browser was left to perform (see `NativeEdit`), already in
  // the model and waiting for its `input` to be checked and rendered.
  private pendingNativeEdit: { edit: NativeEdit; runCount: number } | null =
    null;
  private destroyed = false;
  // Bumped by every import, so one still parsing can tell that a later import
  // has overtaken it. Only imports count: a user edit cannot race an import,
  // because the editor is inert while one is parsing.
  private importGeneration = 0;
  private pendingImports = 0;
  private editable = true;
  private markdownEmitEnabled = true;
  private lastEmittedState: InputState | null = null;

  constructor(
    root: HTMLElement,
    callbacks: InputHostCallbacks = {},
    options: InputHostOptions = {}
  ) {
    this.root = root;
    this.callbacks = callbacks;
    this.pipeline = new EditPipeline(this.formattingStore, this.blockStore);
    this.blockCoordinator = new BlockEditCoordinator(this.blockStore);
    this.typing = new TypingAttributesController(this.formattingStore);
    this.renderer = new DomRenderer(root);
    this.mapper = new SelectionMapper(root, this.renderer);

    injectInputStyles();
    root.classList.add(ENRM_INPUT_CLASS);
    this.setOwnedAttribute('contenteditable', 'true');
    // A consumer may be passing these through as props; theirs wins.
    setAttributeIfAbsent(root, 'role', 'textbox');
    setAttributeIfAbsent(root, 'aria-multiline', 'true');
    if (options.spellCheck !== undefined) {
      root.setAttribute('spellcheck', String(options.spellCheck));
      this.ownedAttributes.push('spellcheck');
    }
    // Not configurable, unlike spellcheck: grammar and translation extensions
    // rewrite the text nodes under us, and nothing in this model can see that
    // happen.
    this.setOwnedAttribute('data-gramm', 'false');
    this.setOwnedAttribute('translate', 'no');

    root.addEventListener('beforeinput', this.handleBeforeInput);
    root.addEventListener('input', this.handleInput);
    root.addEventListener('keydown', this.handleKeyDown);
    root.addEventListener('pointerdown', this.handlePointerDown);
    root.addEventListener('compositionstart', this.handleCompositionStart);
    root.addEventListener('compositionend', this.handleCompositionEnd);
    root.addEventListener('focus', this.handleFocus);
    root.addEventListener('blur', this.handleBlur);
    root.addEventListener('cut', this.handleCut);
    root.addEventListener('paste', this.handlePaste);
    root.ownerDocument.addEventListener(
      'selectionchange',
      this.handleSelectionChange
    );
    root.ownerDocument.addEventListener('pointerup', this.handlePointerUp);
    root.ownerDocument.addEventListener('pointercancel', this.handlePointerUp);

    this.render();
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.session.endComposition();
    this.deferredUntilCompositionEnd = [];
    this.pendingNativeEdit = null;

    this.root.removeEventListener('beforeinput', this.handleBeforeInput);
    this.root.removeEventListener('input', this.handleInput);
    this.root.removeEventListener('keydown', this.handleKeyDown);
    this.root.removeEventListener('pointerdown', this.handlePointerDown);
    this.root.removeEventListener(
      'compositionstart',
      this.handleCompositionStart
    );
    this.root.removeEventListener('compositionend', this.handleCompositionEnd);
    this.root.removeEventListener('focus', this.handleFocus);
    this.root.removeEventListener('blur', this.handleBlur);
    this.root.removeEventListener('cut', this.handleCut);
    this.root.removeEventListener('paste', this.handlePaste);
    this.root.ownerDocument.removeEventListener(
      'selectionchange',
      this.handleSelectionChange
    );
    this.root.ownerDocument.removeEventListener(
      'pointerup',
      this.handlePointerUp
    );
    this.root.ownerDocument.removeEventListener(
      'pointercancel',
      this.handlePointerUp
    );

    // Leave nothing editable behind. A consumer that owns the node and keeps
    // it would otherwise hand the user a contentEditable with no model
    // underneath, which accepts typing and reports none of it.
    for (const attribute of this.ownedAttributes) {
      this.root.removeAttribute(attribute);
    }
    this.root.classList.remove(ENRM_INPUT_CLASS);
    this.root.replaceChildren();
  }

  get value(): string {
    return this.text;
  }

  getMarkdown(): string {
    return serialize(
      this.text,
      this.formattingStore.allRanges,
      this.blockStore.allRanges
    );
  }

  // The prop path (`defaultValue` and friends): loads the markdown without
  // reporting it back, because the app already has this value. Matches
  // Android, which holds its importing phase across the whole import, and
  // iOS, whose `importMarkdown` emits nothing.
  async importValue(markdown: string): Promise<void> {
    await this.loadValue(markdown);
  }

  focus(): void {
    this.root.focus();
  }

  // Writes the attribute rather than the `contentEditable` IDL property, which
  // is how the constructor sets it in the first place - so the node's
  // editability reads the same whether it was set at construction or flipped
  // later. The name is already registered as ours, so teardown clears it.
  setEditable(editable: boolean): void {
    this.editable = editable;
    this.root.setAttribute('contenteditable', editable ? 'true' : 'false');
  }

  // Mirrors native's `isOnChangeMarkdownSet` prop. Every edit would otherwise
  // serialize the whole document, and a wrapper that forwards the event
  // through a stable closure cannot be told apart from a real listener by
  // inspecting the callback.
  setMarkdownEmitEnabled(enabled: boolean): void {
    this.markdownEmitEnabled = enabled;
  }

  // In the root's content coordinates, the way the natives report it: from
  // the padding box's origin, with the root's own scroll offset added, so a
  // scrolled editor reports where the caret sits in its content rather than
  // on screen.
  //
  // Reads the DOM caret while the editor has focus. `selectionchange` is a
  // queued task, so the model selection trails an arrow key until it fires,
  // and a rect asked for in between would describe the old position.
  caretRect(): CaretRect | null {
    const domSelection = this.readDomSelection();
    const offset = domSelection?.selection.start ?? this.selection.start;
    const box = this.caretBoxAtOffset(offset);
    if (box === null) {
      return null;
    }
    const rootRect = this.root.getBoundingClientRect();
    return {
      x: box.left - rootRect.left - this.root.clientLeft + this.root.scrollLeft,
      y: box.top - rootRect.top - this.root.clientTop + this.root.scrollTop,
      // Nothing laid out (a detached editor) has no caret to give a width.
      width: isZeroBox(box) ? 0 : caretWidth(this.root.ownerDocument),
      height: box.height,
    };
  }

  // The caret's box in viewport coordinates; all zeros where nothing is laid
  // out.
  private caretBoxAtOffset(offset: number): CaretBox | null {
    const position = this.mapper.domPositionFromModelOffset(offset);
    if (position === null) {
      return null;
    }
    return caretBoxAt(this.root.ownerDocument, position);
  }

  blur(): void {
    this.root.blur();
  }

  // The imperative command path: loads the markdown and then reports it, the
  // way iOS's `setValue:` command re-emits once the import returns. Keeping
  // the two apart matters at the wrapper, where one `setValue` serving both
  // would make mounting with a `defaultValue` fire `onChangeText` with the
  // value the app just supplied.
  async setValue(markdown: string): Promise<void> {
    if (await this.loadValue(markdown)) {
      this.emitTextEdited();
    }
  }

  // Returns whether the import was applied: a second import started while
  // this one was parsing supersedes it, and so does teardown.
  private async loadValue(markdown: string): Promise<boolean> {
    const generation = ++this.importGeneration;
    // The parse is asynchronous, and the window it opens is the one that
    // needs covering: the phase below only wraps the synchronous model write,
    // which was never at risk. Holding the editor inert for the duration is
    // what native does (its import owns the whole body) and means a keystroke
    // cannot be silently overwritten by the value landing afterwards.
    this.pendingImports++;
    let parsed: Awaited<ReturnType<typeof parseToPlainTextAndRanges>>;
    try {
      parsed = await parseToPlainTextAndRanges(markdown);
    } finally {
      this.pendingImports--;
    }
    if (this.destroyed || generation !== this.importGeneration) {
      return false;
    }
    // Rewriting every node under a running IME would hand its leftovers to a
    // read-back that diffs them against the new model.
    if (this.session.isComposing) {
      await new Promise<void>((resolve) =>
        this.deferredUntilCompositionEnd.push(resolve)
      );
      if (this.destroyed || generation !== this.importGeneration) {
        return false;
      }
    }

    const { plainText, formattingRanges, blockRanges } = parsed;
    this.settleNativeEdit();
    this.session.scoped('importing', () => {
      this.text = plainText;
      this.formattingStore.setRanges(formattingRanges);
      this.blockStore.setRanges(blockRanges);
      this.selection = { start: plainText.length, end: plainText.length };
      this.selectionBackward = false;
    });
    this.render();
    return true;
  }

  // Clamps the way iOS does - into the buffer, then `end` up to `start`, so a
  // reversed range collapses rather than flipping - and additionally snaps off
  // the seam inside a surrogate pair, which UIKit does for us there but which
  // nothing here would catch before the next edit split the pair.
  //
  // Links are atomic here as on both natives: a range is widened to cover
  // any link it cuts, and a caret inside one moves to its end.
  setSelection(start: number, end: number): void {
    this.settleNativeEdit();
    if (this.deferWhileComposing(() => this.setSelection(start, end))) {
      return;
    }
    const max = this.text.length;
    const clampedStart = clamp(start, 0, max);
    const snapped = {
      start: codePointBoundaryAtOrBefore(this.text, clampedStart),
      end: codePointBoundaryAtOrBefore(
        this.text,
        clamp(end, clampedStart, max)
      ),
    };
    this.selection =
      this.formattingStore.selectionAdjustedForAtomicLinks(
        snapped.start,
        snapped.end
      ) ?? snapped;
    this.selectionBackward = false;
    // Nothing in the model changed, so there is nothing to render; only the
    // DOM selection moves.
    this.session.scoped('formatting', () => this.writeSelectionToDom());
    this.resetTypingAfterSelectionMove();
    this.emitSelectionMoved();
  }

  indentList(): void {
    this.command(() => this.changeListDepthBy(1));
  }

  outdentList(): void {
    this.command(() => this.changeListDepthBy(-1));
  }

  toggleUnorderedList(): void {
    this.command(() => this.toggleListType('unordered-list-item'));
  }

  toggleOrderedList(): void {
    this.command(() => this.toggleListType('ordered-list-item'));
  }

  toggleBold(): void {
    this.toggleInlineStyle('strong');
  }

  toggleItalic(): void {
    this.toggleInlineStyle('em');
  }

  toggleUnderline(): void {
    this.toggleInlineStyle('underline');
  }

  toggleStrikethrough(): void {
    this.toggleInlineStyle('strikethrough');
  }

  toggleSpoiler(): void {
    this.toggleInlineStyle('spoiler');
  }

  toggleHeading(level: number): void {
    this.command(() => {
      this.session.scoped('processing', () =>
        this.blockCoordinator.toggleHeading(level, this.selection, this.text)
      );
      this.render();
      this.emitFormattingChanged();
    });
  }

  // A command issued mid-composition would rewrite the nodes under the IME
  // (and move its caret), and a caret toggle would style the word still being
  // composed. It runs once the composition has been read back instead.
  private command(run: () => void): void {
    this.settleNativeEdit();
    if (!this.deferWhileComposing(run)) {
      run();
    }
  }

  private deferWhileComposing(run: () => void): boolean {
    if (!this.session.isComposing) {
      return false;
    }
    this.deferredUntilCompositionEnd.push(run);
    return true;
  }

  private runDeferredCommands(): void {
    const deferred = this.deferredUntilCompositionEnd;
    this.deferredUntilCompositionEnd = [];
    for (const run of deferred) {
      if (this.destroyed || this.session.isComposing) {
        // A new composition began from inside one of them; the rest wait
        // for that one.
        this.deferredUntilCompositionEnd.push(run);
        continue;
      }
      run();
    }
  }

  private readonly handleBeforeInput = (event: InputEvent): void => {
    if (!this.editable) {
      event.preventDefault();
      return;
    }
    // The browser owns the DOM during a composition and `beforeinput` for
    // `insertCompositionText` is not cancelable in every engine, so the model
    // stays out of the way and reads the result back on `compositionend`.
    if (event.isComposing || this.session.isComposing) {
      return;
    }
    this.settleNativeEdit();
    // An import is parsing: the value the app asked for is about to replace
    // everything, so an edit now would be overwritten anyway.
    if (this.pendingImports === 0 && this.letBrowserEdit(event)) {
      return;
    }
    // Default-deny: unhandled input types become no-ops, never native edits.
    event.preventDefault();
    if (this.pendingImports > 0) {
      return;
    }
    this.syncSelectionFromDom();

    switch (event.inputType) {
      // Both carry their range on the event: plain typing addresses the
      // selection, but autocorrect and spellcheck replacements address the
      // word they correct, and Safari can deliver either as `insertText`.
      case 'insertText':
      case 'insertReplacementText':
        this.replaceTargetRange(event, insertedTextOf(event));
        break;
      case 'insertParagraph':
      case 'insertLineBreak':
        this.insertNewline();
        break;
      // Deletes take the platform's range where it supplies one: what a word
      // or a visual line is depends on the locale and the layout (Cmd+Backspace
      // deletes to the start of the visual line, not the previous newline),
      // and only the browser knows either. The scanners are the fallback for
      // an engine that reports no target range.
      case 'deleteContentBackward':
        this.deleteBackwardTo(
          event,
          this.selection.start -
            graphemeLengthBefore(this.text, this.selection.start)
        );
        break;
      case 'deleteContentForward':
        this.deleteForwardTo(
          event,
          this.selection.end +
            graphemeLengthAfter(this.text, this.selection.end)
        );
        break;
      case 'deleteWordBackward':
        this.deleteBackwardTo(
          event,
          wordStartBefore(this.text, this.selection.start)
        );
        break;
      case 'deleteWordForward':
        this.deleteForwardTo(
          event,
          wordEndAfter(this.text, this.selection.end)
        );
        break;
      case 'deleteSoftLineBackward':
      case 'deleteHardLineBackward':
        this.deleteBackwardTo(
          event,
          lineStartBefore(this.text, this.selection.start)
        );
        break;
      case 'deleteSoftLineForward':
      case 'deleteHardLineForward':
        this.deleteForwardTo(
          event,
          lineEndAfter(this.text, this.selection.end)
        );
        break;
      // `deleteByCut` is the second half of a cut, which `handleCut` has
      // already performed; `insertFromPaste` likewise belongs to
      // `handlePaste`. Cancelling them here is what keeps the browser from
      // doing it a second time.
      //
      // Still deliberately denied, with nothing behind them yet:
      // - `insertParagraph` / `insertLineBreak`: Enter, which has to continue
      //   lists and split blocks. Lands with the formatting commands.
      // - `formatBold` and friends: the commands own these, including the
      //   keyboard shortcuts that raise them.
      // - `historyUndo` / `historyRedo`: every model edit is a scripted
      //   `nodeValue` write, so the browser's undo stack is empty and there is
      //   nothing to diverge from - but there is no undo either until the
      //   model keeps its own stack.
      // - `insertFromDrop`: needs a caret-from-point mapping to know where the
      //   drop landed. Denying it is inert rather than wrong.
      default:
        break;
    }
  };

  // Takes the edit into the model and leaves the DOM to the browser, when the
  // browser's edit is exactly what a render would write (see `NativeEdit`).
  // Returns false, with nothing changed, for any edit that is not a
  // candidate; true once the edit is handled either way - a candidate whose
  // runs turn out to differ is cancelled here and rendered from the model.
  private letBrowserEdit(event: InputEvent): boolean {
    if (this.renderer.hasDirtyLines) {
      return false;
    }
    const edit = planNativeEdit(event, {
      root: this.root,
      isLine: this.isRenderedLine,
      modelOffsetFromDom: (node, offset) =>
        this.mapper.modelOffsetFromDom(node, offset),
    });
    if (edit === null) {
      return false;
    }
    const { editStart, deletedText, insertedText } = edit;
    // A Backspace into a link deletes all of it, which is the model's edit
    // to make.
    if (
      deletedText.length > 0 &&
      this.formattingStore.isStyleActiveInRange(
        'link',
        editStart,
        editStart + deletedText.length
      )
    ) {
      return false;
    }
    this.syncSelectionFromDom();
    this.applyModelEdit(editStart, deletedText, insertedText);
    const line = lineAtPosition(editStart, this.text);
    const runs = computeStyleRuns(
      this.formattingStore.allRanges,
      line.start,
      line.end
    );
    if (!spansMatchRuns(edit, runs, this.text)) {
      event.preventDefault();
      this.renderEdit();
      return true;
    }
    this.pendingNativeEdit = { edit, runCount: runs.length };
    // `input` follows within the same task; the timer is for an engine that
    // lets the event through and then performs nothing.
    setTimeout(() => this.settleNativeEdit(), 0);
    return true;
  }

  // Renders a native edit once the browser has made it. When it landed as
  // planned the render finds every node already right, writes nothing, and
  // leaves the caret alone - the point of the exercise. When it did not, the
  // line is rewritten from the model.
  private settleNativeEdit(): void {
    const pending = this.pendingNativeEdit;
    if (pending === null || this.destroyed) {
      return;
    }
    this.pendingNativeEdit = null;
    if (
      !nativeEditLanded(pending.edit, this.isRenderedLine, pending.runCount)
    ) {
      const index = this.renderer.indexOfLine(pending.edit.line);
      if (index === -1) {
        this.renderer.invalidate();
      } else {
        this.renderer.markLinesDirty(index, index);
      }
    }
    this.render();
    this.emitTextEdited();
  }

  private readonly isRenderedLine = (node: Node): boolean =>
    this.renderer.indexOfLine(node) !== -1;

  private syncSelectionFromDom(): void {
    const mapped = this.readDomSelection();
    if (mapped !== null) {
      this.selection = mapped.selection;
      this.selectionBackward = mapped.backward;
    }
  }

  // The DOM selection in model offsets, snapped off any surrogate seam the
  // way `setSelection` snaps its arguments: a caret the browser parks inside
  // a pair would otherwise split it on the next edit.
  private readDomSelection(): {
    selection: RangeBounds;
    backward: boolean;
  } | null {
    const domSelection = this.root.ownerDocument.getSelection();
    if (domSelection === null) {
      return null;
    }
    const points = this.mapper.modelSelectionFromDom(domSelection);
    if (points === null) {
      return null;
    }
    const anchor = this.snapToModel(points.anchor);
    const focus = this.snapToModel(points.focus);
    return {
      selection: {
        start: Math.min(anchor, focus),
        end: Math.max(anchor, focus),
      },
      backward: focus < anchor,
    };
  }

  private snapToModel(offset: number): number {
    return codePointBoundaryAtOrBefore(
      this.text,
      clamp(offset, 0, this.text.length)
    );
  }

  // Tab never reaches beforeinput (the browser moves focus), so it is the
  // one key handled here.
  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    if (!this.editable || event.key !== 'Tab' || this.session.isComposing) {
      return;
    }
    event.preventDefault();
    this.settleNativeEdit();
    this.syncSelectionFromDom();
    if (event.shiftKey) {
      this.outdentList();
    } else {
      this.indentList();
    }
  };

  private readonly handleCompositionStart = (): void => {
    this.settleNativeEdit();
    if (this.pendingImports === 0) {
      this.syncSelectionFromDom();
    }
    this.session.beginComposition();
    // The IME writes into the lines under the selection and leaves whatever
    // node shapes it likes there; those lines get rewritten once it is done,
    // even where the text it leaves matches the model.
    this.renderer.markLinesDirty(
      this.mapper.lineIndexAt(this.selection.start),
      this.mapper.lineIndexAt(this.selection.end)
    );
    // The placeholder is drawn over the content box, and the composed text is
    // in the DOM long before it is in the model.
    this.root.toggleAttribute('data-empty', false);
  };

  private readonly handleCompositionEnd = (): void => {
    this.endComposition();
  };

  private endComposition(): void {
    this.session.endComposition();
    this.recoverComposition();
    this.runDeferredCommands();
  }

  // `input` arrives for every DOM change the browser made itself, which is
  // never one of ours: a cancelled `beforeinput` raises none, and scripted
  // writes raise none either. Two kinds reach here.
  //
  // Composition updates. The model follows them without rendering, so
  // `value`, `onChangeText` and `getMarkdown` include the word being composed
  // - on Chrome Android it stays composed until a space, and a Send button
  // that keeps focus would otherwise drop it. Android native does the same
  // with its composing span.
  //
  // Everything else is an edit that escaped `preventDefault`: Android Chrome
  // on some `deleteContentBackward`, a non-cancelable input type,
  // `execCommand`, an extension. It is read back like a composition so the
  // model and the screen agree again.
  private readonly handleInput = (event: Event): void => {
    if (this.destroyed) {
      return;
    }
    const composing =
      (event as InputEvent).isComposing || this.session.isComposing;
    if (!composing && this.pendingNativeEdit !== null) {
      this.settleNativeEdit();
      return;
    }
    if (composing) {
      if (this.editable && this.pendingImports === 0) {
        this.readBackFromDom({ render: false });
      }
      return;
    }
    this.renderer.markLinesDirty(
      this.mapper.lineIndexAt(this.selection.start),
      this.mapper.lineIndexAt(this.selection.end)
    );
    if (this.pendingImports > 0) {
      // The import is about to replace everything; put the model back.
      this.renderer.invalidate();
      this.render();
      return;
    }
    this.recoverComposition();
  };

  private readonly handlePointerDown = (event: PointerEvent): void => {
    this.pointerSelecting = event.isPrimary && event.button === 0;
  };

  private readonly handlePointerUp = (): void => {
    if (!this.pointerSelecting) {
      return;
    }
    this.pointerSelecting = false;
    // The gesture's last selection change came while it was still running
    // and was left unsnapped.
    this.handleSelectionChange();
  };

  private readonly handleFocus = (): void => {
    // The browser places its own caret when a contentEditable takes focus, and
    // `writeSelectionToDom` declines to write while the editor is unfocused.
    // Without this, a `setSelection` issued before the focus would be
    // overwritten by that caret the moment the focus arrived.
    if (this.destroyed) {
      return;
    }
    this.session.scoped('formatting', () => this.writeSelectionToDom());
  };

  private readonly handleBlur = (): void => {
    // A composition abandoned by a blur does not always fire
    // `compositionend`, and a latched composition flag makes the editor
    // read-only: every `beforeinput` short-circuits.
    if (this.session.isComposing) {
      this.endComposition();
    }
  };

  // A composition that ends on a read-only editor - `editable` was flipped
  // while the IME held the DOM - must not be read back as an edit, but the
  // nodes the IME left behind still have to go, so the model is rendered over
  // them instead.
  private recoverComposition(): void {
    if (this.editable) {
      this.readBackFromDom();
      return;
    }
    this.renderer.invalidate();
    this.render();
  }

  private readonly handleCut = (event: ClipboardEvent): void => {
    // The UA writes the clipboard and then performs the deletion, whose
    // `beforeinput` arrives as `deleteByCut` and gets cancelled. Taking over
    // both halves is what stops a cut from copying the text and leaving it
    // in place. On a read-only editor both halves stay cancelled, the way
    // iOS and Android drop Cut from the menu and leave Copy, which is not
    // intercepted here at all.
    event.preventDefault();
    if (!this.editable || this.session.isComposing || this.pendingImports > 0) {
      return;
    }
    this.settleNativeEdit();
    this.syncSelectionFromDom();
    const { start, end } = this.selection;
    if (start === end) {
      return;
    }
    event.clipboardData?.setData('text/plain', this.text.slice(start, end));
    this.applyEdit(start, this.text.slice(start, end), '');
  };

  private readonly handlePaste = (event: ClipboardEvent): void => {
    event.preventDefault();
    if (!this.editable || this.session.isComposing || this.pendingImports > 0) {
      return;
    }
    this.settleNativeEdit();
    // Plain text only. Pasting markdown as formatted content means running
    // the parser and merging an import into the middle of the buffer, which
    // is a separate concern from this shell.
    const pasted = event.clipboardData?.getData('text/plain') ?? '';
    if (pasted.length === 0) {
      return;
    }
    this.syncSelectionFromDom();
    this.replaceSelection(normalizeLineEndings(pasted));
  };

  private readonly handleSelectionChange = (): void => {
    // This guard only catches a side effect delivered on the same stack as
    // the write. `selectionchange` is queued on the user interaction task
    // source instead, so by delivery time the render's scope has exited and
    // the phase is back to idle. What actually swallows the echo of our own
    // render is the offset comparison at the end: the mapper's round trip is
    // lossless, so a caret we just restored maps back to the offset already
    // held. Do not drop it as redundant.
    if (
      this.session.shouldSuppressSelectionSideEffects ||
      this.session.isComposing ||
      this.destroyed
    ) {
      return;
    }
    // A render dirties any selection inside the nodes it rewrites (replacing a
    // text node's data collapses the live ranges within it), and
    // `writeSelectionToDom` only puts it back while the editor has focus.
    // Without this, that unrestored selection arrives here and reports a
    // change for a document the user never touched.
    if (!this.hasFocus()) {
      return;
    }
    this.settleNativeEdit();
    const domSelection = this.root.ownerDocument.getSelection();
    const read = this.readDomSelection();
    if (domSelection === null || read === null) {
      return;
    }
    // Links are atomic: a caret inside one moves to its end and a range
    // cutting one widens over it, as on both natives. Not while a pointer
    // gesture is still selecting; `handlePointerUp` comes back for it.
    const atomic = this.pointerSelecting
      ? null
      : this.formattingStore.selectionAdjustedForAtomicLinks(
          read.selection.start,
          read.selection.end
        );
    const mapped = atomic ?? read.selection;
    const backward = atomic === null ? read.backward : false;
    if (
      mapped.start === this.selection.start &&
      mapped.end === this.selection.end
    ) {
      this.selectionBackward = backward;
      // The comparison has to be in model offsets rather than on node
      // identity: a render replaces the nodes the selection pointed into, so
      // the echo of our own write arrives pointing somewhere else entirely
      // while describing the same offsets.
      //
      // Those offsets are not the whole story, though. The mapping is lossy
      // over an empty line, whose only node is a `<br>`: both ends of a DOM
      // range inside it map to the one model offset, so a stretched highlight
      // reports as a collapsed caret. The model did not move, so nothing is
      // emitted, but the DOM still shows the highlight and needs the write.
      if (
        atomic !== null ||
        domSelection.isCollapsed !== (mapped.start === mapped.end)
      ) {
        this.session.scoped('formatting', () => this.writeSelectionToDom());
      }
      return;
    }
    this.selection = mapped;
    this.selectionBackward = backward;
    if (atomic !== null) {
      this.session.scoped('formatting', () => this.writeSelectionToDom());
    }
    this.resetTypingAfterSelectionMove();
    this.emitSelectionMoved();
  };

  // Every selection change that reaches here is the user's: the echo of our
  // own caret write maps back to the offsets already held and is swallowed
  // above, so no time window is needed to tell the two apart. (iOS keeps a
  // 100 ms one; Android a one-shot flag.)
  private resetTypingAfterSelectionMove(): void {
    this.typing.resetForSelectionChange(this.selection);
  }

  // The browser owns the DOM through a composition, so the composed text
  // lands without the model seeing it. This recovers it afterwards: read the
  // text back out of the rendered nodes, diff it against the model to get the
  // one edit the composition made, and run that edit through the ordinary
  // path.
  //
  // Without this the two diverge permanently - the composed text stays on
  // screen while `value` and `onChangeText` omit it, so the user saves and
  // their text is not there - and whatever nodes the IME left behind go on
  // confusing the selection mapping. The scope is wider than CJK: macOS dead
  // keys, iOS Safari autocorrect and GBoard suggestions all compose.
  //
  // The diff is anchored on the DOM caret. The shared prefix and suffix of
  // the two buffers overlap whenever the edit sits next to a copy of itself -
  // composing `a` in front of `apple`, `l` into `helo` - and the longest
  // prefix then puts the edit, and the model caret, one character too far.
  // `render: false` is the mid-composition update: the model follows the
  // DOM, but the DOM is the IME's until it ends.
  private readBackFromDom({ render = true }: { render?: boolean } = {}): void {
    if (this.destroyed) {
      return;
    }
    const domSelection = this.root.ownerDocument.getSelection();
    const focus =
      domSelection?.focusNode != null &&
      this.root.contains(domSelection.focusNode)
        ? { node: domSelection.focusNode, offset: domSelection.focusOffset }
        : null;
    const { text: domText, caret } = readTextFromDom(this.root, focus);
    if (domText === this.text) {
      // Nothing to recover, but the IME may still have left non-canonical
      // nodes behind. The lines it touched were marked dirty when it
      // started, so this render rewrites them even though the model is
      // unchanged.
      if (render) {
        this.render();
      }
      return;
    }
    const { editStart, deletedText, insertedText } = diffEdit(
      this.text,
      domText,
      caret
    );
    this.applyEdit(editStart, deletedText, insertedText, {
      caret: caret === null ? undefined : caret,
      render,
    });
  }

  private insertNewline(): void {
    const { start, end } = this.selection;
    if (start === end && this.unlistEmptyListItem(start)) {
      return;
    }
    this.replaceSelection('\n');
  }

  private unlistEmptyListItem(caret: number): boolean {
    const line = lineAtPosition(caret, this.text);
    const block = this.blockStore.blockAt(caret, this.text);
    if (line.start !== line.end || !isListItem(block)) {
      return false;
    }
    this.toggleListType(block.type);
    return true;
  }

  // Backspace at the start of a list item outdents it, or un-lists it at
  // depth 0, instead of merging with the line above.
  private outdentListAtLineStart(caret: number): boolean {
    const line = lineAtPosition(caret, this.text);
    if (
      caret !== line.start ||
      !isListItem(this.blockStore.blockAt(caret, this.text))
    ) {
      return false;
    }
    this.outdentList();
    return true;
  }

  private changeListDepthBy(delta: number): void {
    const changed = this.session.scoped('processing', () =>
      this.blockCoordinator.changeListDepthBy(delta, this.selection, this.text)
    );
    if (changed) {
      this.render();
      this.emitFormattingChanged();
    }
  }

  private toggleListType(type: BlockType): void {
    // Also reached from Enter and Backspace, which never run mid-composition.
    this.session.scoped('processing', () =>
      this.blockCoordinator.toggleListType(type, this.selection, this.text)
    );
    this.render();
    this.emitFormattingChanged();
  }

  private toggleInlineStyle(type: PendingStyleType): void {
    this.command(() => {
      const { start, end } = this.selection;
      const wasActive = this.session.scoped('processing', () =>
        this.formattingStore.toggleStyle(type, start, end)
      );
      this.typing.toggleStyle(type, wasActive, start !== end);
      if (start === end) {
        // A caret toggle only pends a style for the next keystroke; the
        // stores, and so the DOM and the markdown, are unchanged.
        this.emitState();
        return;
      }
      this.render();
      this.emitFormattingChanged();
    });
  }

  insertText(text: string): void {
    this.command(() => this.replaceSelection(text));
  }

  private replaceSelection(insertedText: string): void {
    const { start, end } = this.selection;
    this.applyEdit(start, this.text.slice(start, end), insertedText);
  }

  // The event's own range where it carries one, the selection otherwise - an
  // `insertReplacementText` without target ranges still replaces what is
  // selected rather than being dropped.
  private replaceTargetRange(event: InputEvent, insertedText: string): void {
    const target = this.modelRangeFromTargetRanges(event) ?? this.selection;
    if (insertedText.length === 0 && target.start === target.end) {
      return;
    }
    this.applyEdit(
      target.start,
      this.text.slice(target.start, target.end),
      insertedText
    );
  }

  // The range an input type carries on the event rather than in the selection.
  private modelRangeFromTargetRanges(event: InputEvent): RangeBounds | null {
    if (typeof event.getTargetRanges !== 'function') {
      return null;
    }
    const [target] = event.getTargetRanges();
    if (target === undefined) {
      return null;
    }
    const start = this.mapper.modelOffsetFromDom(
      target.startContainer,
      target.startOffset
    );
    const end = this.mapper.modelOffsetFromDom(
      target.endContainer,
      target.endOffset
    );
    if (start === null || end === null) {
      return null;
    }
    const from = this.snapToModel(Math.min(start, end));
    const to = this.snapToModel(Math.max(start, end));
    return { start: from, end: to };
  }

  // Deletes back to the event's target range, or to `fallback` where the
  // engine reports none. A target that makes no progress - a word or line
  // delete with the caret already at a line start - falls back to one
  // character, which is the newline, so the press joins the lines instead of
  // doing nothing.
  private deleteBackwardTo(event: InputEvent, fallback: number): void {
    const { start, end } = this.selection;
    if (start !== end) {
      this.replaceSelection('');
      return;
    }
    if (this.outdentListAtLineStart(start) || start === 0) {
      return;
    }
    if (this.deleteLinkBefore(start)) {
      return;
    }
    const target = this.modelRangeFromTargetRanges(event);
    if (target !== null && target.start < target.end) {
      this.deleteRange(target);
      return;
    }
    const from =
      fallback < start
        ? fallback
        : start - graphemeLengthBefore(this.text, start);
    this.applyEdit(from, this.text.slice(from, start), '');
  }

  private deleteForwardTo(event: InputEvent, fallback: number): void {
    const { start, end } = this.selection;
    if (start !== end) {
      this.replaceSelection('');
      return;
    }
    if (end >= this.text.length) {
      return;
    }
    const target = this.modelRangeFromTargetRanges(event);
    if (target !== null && target.start < target.end) {
      this.deleteRange(target);
      return;
    }
    const to =
      fallback > end ? fallback : end + graphemeLengthAfter(this.text, end);
    this.applyEdit(end, this.text.slice(end, to), '');
  }

  private deleteRange({ start, end }: RangeBounds): void {
    this.applyEdit(start, this.text.slice(start, end), '');
  }

  // Backspace with the caret on a link's last character, or anywhere inside
  // it, deletes the whole link rather than leaving a partial one pointing at
  // the old url. Both natives do this (iOS `deleteLinkForReplacementRange:`,
  // Android `deleteLinkBeforeCursor`).
  private deleteLinkBefore(caret: number): boolean {
    const link = this.formattingStore.rangeOfType('link', caret - 1);
    if (link === null) {
      return false;
    }
    this.applyEdit(link.start, this.text.slice(link.start, link.end), '');
    return true;
  }

  // The native keystroke choreography: model phase, render phase, then
  // events, in the iOS order.
  //
  // `caret` overrides where the caret lands, for a read-back that knows it
  // from the DOM; `render: false` leaves the DOM alone, for one that runs
  // while the IME still owns it.
  private applyEdit(
    editStart: number,
    deletedText: string,
    insertedText: string,
    { caret, render = true }: { caret?: number; render?: boolean } = {}
  ): void {
    this.applyModelEdit(editStart, deletedText, insertedText, caret);
    if (render) {
      this.renderEdit();
    } else {
      this.emitTextEdited();
    }
  }

  private renderEdit(): void {
    this.render();
    this.scrollCaretIntoView();
    this.emitTextEdited();
  }

  // The model half of an edit: text, stores and caret, without touching the
  // DOM or reporting anything.
  private applyModelEdit(
    editStart: number,
    deletedText: string,
    insertedText: string,
    caret?: number
  ): void {
    this.session.scoped('processing', () => {
      this.text =
        this.text.slice(0, editStart) +
        insertedText +
        this.text.slice(editStart + deletedText.length);
      this.pipeline.processTextChange(this.text, {
        editStart,
        deletedText,
        insertedText,
        pendingStyles: this.typing.styles,
        pendingStyleRemovals: this.typing.styleRemovals,
      });
      const landing = this.snapToModel(
        caret ?? editStart + insertedText.length
      );
      this.selection = { start: landing, end: landing };
      this.selectionBackward = false;
    });
  }

  // A scripted caret write does not scroll, unlike a caret the browser moves
  // itself: typing or Enter at the bottom of a scrolled editor would leave
  // the caret below the box. Only after edits - a selection the user moved is
  // already where they are looking.
  private scrollCaretIntoView(): void {
    if (!this.hasFocus()) {
      return;
    }
    const box = this.caretBoxAtOffset(this.selection.end);
    if (box !== null && !isZeroBox(box)) {
      scrollBoxIntoView(this.root, box);
    }
  }

  private render(): void {
    // The IME owns the DOM until the composition ends, and every path that
    // gets here mid-composition is deferred or reads back without rendering;
    // the render that follows `compositionend` catches up.
    if (this.session.isComposing) {
      return;
    }
    this.session.scoped('formatting', () => {
      this.root.toggleAttribute(
        'data-empty',
        this.text.length === 0 && this.blockStore.allRanges.length === 0
      );
      this.renderer.render(
        this.text,
        projectParagraphs(
          this.text,
          this.formattingStore.allRanges,
          this.blockStore.allRanges
        )
      );
      this.writeSelectionToDom();
    });
  }

  private writeSelectionToDom(): void {
    // Moving the selection under an IME moves its composition with it.
    if (!this.hasFocus() || this.session.isComposing) {
      return;
    }
    const domSelection = this.root.ownerDocument.getSelection();
    if (domSelection === null) {
      return;
    }
    const { start, end } = this.selection;
    const collapsed = start === end;
    const anchorOffset = this.selectionBackward ? end : start;
    const focusOffset = this.selectionBackward ? start : end;
    const current = this.mapper.modelSelectionFromDom(domSelection);
    if (
      current !== null &&
      current.anchor === anchorOffset &&
      current.focus === focusOffset &&
      domSelection.isCollapsed === collapsed
    ) {
      return;
    }
    const anchor = this.mapper.domPositionFromModelOffset(anchorOffset);
    const focus = collapsed
      ? anchor
      : this.mapper.domPositionFromModelOffset(focusOffset);
    if (anchor === null || focus === null) {
      return;
    }
    domSelection.setBaseAndExtent(
      anchor.node,
      anchor.offset,
      focus.node,
      focus.offset
    );
  }

  private hasFocus(): boolean {
    return this.root.contains(this.root.ownerDocument.activeElement);
  }

  private setOwnedAttribute(name: string, value: string): void {
    this.root.setAttribute(name, value);
    this.ownedAttributes.push(name);
  }

  private emitText(): void {
    if (this.session.shouldSuppressEvents) {
      return;
    }
    this.callbacks.onChangeText?.(this.text);
  }

  private emitSelection(): void {
    if (this.session.shouldSuppressEvents) {
      return;
    }
    this.callbacks.onChangeSelection?.(this.selection);
  }

  private emitState(): void {
    if (this.session.shouldSuppressEvents) {
      return;
    }
    const state = buildInputState(
      this.formattingStore,
      this.blockStore,
      this.typing,
      this.selection,
      this.text
    );
    if (
      this.lastEmittedState !== null &&
      sameInputState(state, this.lastEmittedState)
    ) {
      return;
    }
    this.lastEmittedState = state;
    this.callbacks.onChangeState?.(state);
  }

  private emitMarkdown(): void {
    if (
      this.session.shouldSuppressEvents ||
      !this.markdownEmitEnabled ||
      !this.callbacks.onChangeMarkdown
    ) {
      return;
    }
    this.callbacks.onChangeMarkdown(this.getMarkdown());
  }

  private emitTextEdited(): void {
    this.emitText();
    this.emitSelection();
    this.emitState();
    this.emitMarkdown();
  }

  private emitFormattingChanged(): void {
    this.emitState();
    this.emitMarkdown();
  }

  private emitSelectionMoved(): void {
    this.emitSelection();
    this.emitState();
  }
}

interface CaretBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

// The viewport box of a caret at `position`.
//
// The last client rect, not the bounding one: at the start of a soft-wrapped
// visual line the collapsed range reports a rect on each side of the wrap,
// and the bounding box of the two is anchored at the previous line's end.
//
// A range collapsed at an element boundary has no client rects in Blink or
// WebKit, and `getBoundingClientRect` answers an all-zero box there rather
// than a position - which is exactly where an empty line's caret sits,
// because the line renders as a lone `<br>` and the mapper resolves it to the
// line element itself. The `<br>` stands in there: it sits where the caret
// does, after any list indent and on the RTL side, and is as tall as the text
// rather than the line box.
function caretBoxAt(document: Document, position: DomPosition): CaretBox {
  const range = document.createRange();
  range.setStart(position.node, position.offset);
  range.collapse(true);
  // Neither is implemented by every DOM (jsdom has neither).
  if (typeof range.getClientRects === 'function') {
    const rects = range.getClientRects();
    const last = rects.length > 0 ? rects[rects.length - 1]! : null;
    if (last !== null && !isZeroBox(last)) {
      return last;
    }
  }
  const rect =
    typeof range.getBoundingClientRect === 'function'
      ? range.getBoundingClientRect()
      : ZERO_BOX;
  if (!isZeroBox(rect)) {
    return rect;
  }
  const element =
    position.node.nodeType === Node.ELEMENT_NODE
      ? (position.node as Element)
      : position.node.parentElement;
  if (element === null) {
    return rect;
  }
  for (const candidate of [lineBreakOf(element), element]) {
    const box = candidate?.getBoundingClientRect();
    if (box !== undefined && !isZeroBox(box)) {
      return { left: box.left, top: box.top, width: 0, height: box.height };
    }
  }
  return rect;
}

function lineBreakOf(line: Element): Element | null {
  for (const child of line.children) {
    if (child.nodeName === 'BR') {
      return child;
    }
  }
  return null;
}

const ZERO_BOX: CaretBox = { left: 0, top: 0, width: 0, height: 0 };

// Two physical pixels, as Android reports it (`2f / density`).
function caretWidth(document: Document): number {
  return 2 / (document.defaultView?.devicePixelRatio || 1);
}

// Scrolls every scrolling ancestor of `element`, then the viewport, by the
// least that brings `box` into view - `scrollIntoView({ block: 'nearest' })`
// for a rect rather than an element. Scrolling the caret's run span instead
// would align a multi-line run by its edge, not by the caret.
function scrollBoxIntoView(element: HTMLElement, box: CaretBox): void {
  const document = element.ownerDocument;
  const view = document.defaultView;
  let { top, left } = box;
  const { width, height } = box;
  for (
    let current: HTMLElement | null = element;
    current !== null &&
    current !== document.body &&
    current !== document.documentElement;
    current = current.parentElement
  ) {
    if (!isScrollContainer(current)) {
      continue;
    }
    const rect = current.getBoundingClientRect();
    const viewTop = rect.top + current.clientTop;
    const viewLeft = rect.left + current.clientLeft;
    const dy = scrollDelta(top, height, viewTop, current.clientHeight);
    const dx = scrollDelta(left, width, viewLeft, current.clientWidth);
    if (dy === 0 && dx === 0) {
      continue;
    }
    const scrollTop = current.scrollTop;
    const scrollLeft = current.scrollLeft;
    current.scrollTop += dy;
    current.scrollLeft += dx;
    top -= current.scrollTop - scrollTop;
    left -= current.scrollLeft - scrollLeft;
  }
  if (view === null) {
    return;
  }
  const dy = scrollDelta(top, height, 0, view.innerHeight);
  const dx = scrollDelta(left, width, 0, view.innerWidth);
  if (dy !== 0 || dx !== 0) {
    view.scrollBy(dx, dy);
  }
}

function scrollDelta(
  start: number,
  size: number,
  viewStart: number,
  viewSize: number
): number {
  if (start < viewStart) {
    return start - viewStart;
  }
  const overflow = start + size - (viewStart + viewSize);
  // A box taller than the view keeps its start in view.
  return overflow > 0 ? Math.min(overflow, start - viewStart) : 0;
}

function isScrollContainer(element: HTMLElement): boolean {
  if (
    element.scrollHeight <= element.clientHeight &&
    element.scrollWidth <= element.clientWidth
  ) {
    return false;
  }
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  return (
    style !== undefined &&
    /(auto|scroll|overlay)/.test(`${style.overflowY} ${style.overflowX}`)
  );
}

function isZeroBox(box: CaretBox): boolean {
  return box.left === 0 && box.top === 0 && box.width === 0 && box.height === 0;
}

function setAttributeIfAbsent(
  element: HTMLElement,
  name: string,
  value: string
): void {
  if (!element.hasAttribute(name)) {
    element.setAttribute(name, value);
  }
}

// `insertText` and `insertReplacementText` carry their text on `data` in some
// engines and in the data transfer in others.
function insertedTextOf(event: InputEvent): string {
  return normalizeLineEndings(
    event.data ?? event.dataTransfer?.getData('text/plain') ?? ''
  );
}

// The buffer uses bare newlines, so a clipboard's line endings are converted
// rather than stored as text.
function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

// Recovers the plain text the DOM currently shows, in the shape `render`
// writes it: one line per element child of the root. Also places `point` (the
// DOM caret) in that text, or answers null when it is not inside the root.
//
// Reads whatever the DOM holds, canonical or not, so the caret is placed by
// walking the same nodes rather than through the mapper, which only knows the
// renderer's own lines.
export function readTextFromDom(
  root: HTMLElement,
  point: DomPosition | null = null
): { text: string; caret: number | null } {
  const lines: string[] = [];
  // Length of `lines.join('\n')` so far.
  let length = 0;
  let caret: number | null = null;
  const children = root.childNodes;
  for (let i = 0; i < children.length; i++) {
    const node = children[i]!;
    const isLine = node.nodeType === Node.ELEMENT_NODE;
    const text = node.textContent ?? '';
    // A text node an IME or an extension dropped directly under the root
    // belongs to the line it was dropped beside, not to a line of its own.
    const startsLine = isLine || lines.length === 0;
    const nodeStart = startsLine && lines.length > 0 ? length + 1 : length;
    if (point !== null && caret === null) {
      if (point.node === root && point.offset === i) {
        caret = nodeStart;
      } else if (point.node === node || node.contains(point.node)) {
        caret = nodeStart + textLengthWithin(node, point);
      }
    }
    if (!isLine && text.length === 0) {
      continue;
    }
    if (startsLine) {
      lines.push(text);
    } else {
      lines[lines.length - 1] += text;
    }
    length = nodeStart + text.length;
  }
  if (point !== null && caret === null && point.node === root) {
    caret = length;
  }
  return { text: lines.join('\n'), caret };
}

// The length of the text inside `container` before `point`, which lies in it.
function textLengthWithin(container: Node, point: DomPosition): number {
  if (point.node === container && point.node.nodeType === Node.TEXT_NODE) {
    return Math.min(point.offset, (container as Text).length);
  }
  const range = container.ownerDocument!.createRange();
  range.setStart(container, 0);
  range.setEnd(
    point.node,
    Math.min(
      point.offset,
      point.node.nodeType === Node.TEXT_NODE
        ? (point.node as Text).length
        : point.node.childNodes.length
    )
  );
  return range.toString().length;
}

// The one contiguous edit between two buffers, bounded by their shared prefix
// and suffix. A composition commits as a single replacement, so one window is
// all there is to find.
//
// Where the shared prefix and suffix overlap, the edit could sit anywhere in
// the overlap (`a` + `apple` is an insert at 0 or at 1), and `caret` - where
// the DOM caret is in `next` - picks the placement that ends the inserted
// text at it, the way ProseMirror's `findDiff` does. Without a caret the
// longest prefix wins.
export function diffEdit(
  previous: string,
  next: string,
  caret: number | null = null
): { editStart: number; deletedText: string; insertedText: string } {
  const maxShared = Math.min(previous.length, next.length);

  let commonPrefix = 0;
  while (
    commonPrefix < maxShared &&
    previous[commonPrefix] === next[commonPrefix]
  ) {
    commonPrefix++;
  }
  let commonSuffix = 0;
  while (
    commonSuffix < maxShared &&
    previous[previous.length - 1 - commonSuffix] ===
      next[next.length - 1 - commonSuffix]
  ) {
    commonSuffix++;
  }

  let prefix = commonPrefix;
  if (caret !== null && commonPrefix + commonSuffix > maxShared) {
    // The suffix that ends the inserted text at the caret, kept within the
    // range where both windows still hold.
    prefix = clamp(
      maxShared - next.length + caret,
      maxShared - commonSuffix,
      commonPrefix
    );
  }
  let suffix = Math.min(commonSuffix, maxShared - prefix);

  // The stores index code units, so a boundary inside a surrogate pair would
  // leave half a character on each side of the edit.
  while (prefix > 0 && !isCodePointBoundary(next, prefix)) {
    prefix--;
  }
  while (suffix > 0 && !isCodePointBoundary(next, next.length - suffix)) {
    suffix--;
  }

  return {
    editStart: prefix,
    deletedText: previous.slice(prefix, previous.length - suffix),
    insertedText: next.slice(prefix, next.length - suffix),
  };
}

// Start of the word before `position`: the whitespace immediately before it,
// then the run of non-whitespace before that. A line break bounds the scan,
// so one press never reaches onto the previous line.
function wordStartBefore(text: string, position: number): number {
  let index = position;
  while (index > 0 && isInlineWhitespace(text[index - 1]!)) {
    index--;
  }
  while (index > 0 && isWordCharacter(text[index - 1]!)) {
    index--;
  }
  return index;
}

function wordEndAfter(text: string, position: number): number {
  let index = position;
  while (index < text.length && isInlineWhitespace(text[index]!)) {
    index++;
  }
  while (index < text.length && isWordCharacter(text[index]!)) {
    index++;
  }
  return index;
}

function lineStartBefore(text: string, position: number): number {
  return text.lastIndexOf('\n', position - 1) + 1;
}

function lineEndAfter(text: string, position: number): number {
  const next = text.indexOf('\n', position);
  return next === -1 ? text.length : next;
}

function isInlineWhitespace(char: string): boolean {
  return char !== '\n' && isWhitespace(char);
}

function isWordCharacter(char: string): boolean {
  return char !== '\n' && !isWhitespace(char);
}
