import { classNameFor, isReusableRun } from '../render/DomRenderer';
import type { StyleRun } from '../render/InputProjection';

// An edit the browser is left to perform itself, inside one run's text node.
//
// Every other edit is cancelled at `beforeinput` and rendered from the model,
// which rewrites the text node and so has to restore the caret by script
// afterwards - a forced layout plus `setBaseAndExtent`, which is most of a
// keystroke's cost on a long document and grows with it. Plain typing and a
// one-character delete inside a run need neither: the browser's own edit
// produces exactly the DOM the model would render, and leaves the caret where
// the model puts it. Letting it through also keeps Blink's spellcheck markers
// on the word being typed.
//
// The decision is made by prediction: what the text node will hold once the
// browser is done (`nodeText`), checked against the model's own runs for the
// line before the event is let through, and checked against the DOM again
// once `input` reports the edit happened.
export interface NativeEdit {
  editStart: number;
  deletedText: string;
  insertedText: string;
  line: Element;
  span: Element;
  node: Text;
  nodeText: string;
}

export interface NativeEditContext {
  root: HTMLElement;
  isLine(node: Node): boolean;
  modelOffsetFromDom(node: Node, offset: number): number | null;
}

// The edit `event` would make if the browser performed it, where that edit
// stays inside a single canonical run's text node; null for everything else,
// which takes the cancel-and-render path.
export function planNativeEdit(
  event: InputEvent,
  context: NativeEditContext
): NativeEdit | null {
  switch (event.inputType) {
    case 'insertText':
      return planInsert(event, context);
    case 'deleteContentBackward':
    case 'deleteContentForward':
      return planDelete(event, context);
    default:
      return null;
  }
}

function planInsert(
  event: InputEvent,
  context: NativeEditContext
): NativeEdit | null {
  const data = event.data;
  // A newline is a structural edit, and the data transfer form is Safari's
  // and rare enough to leave to the model.
  if (data === null || data.length === 0 || /[\r\n]/.test(data)) {
    return null;
  }
  const selection = context.root.ownerDocument.getSelection();
  if (selection === null || !selection.isCollapsed) {
    return null;
  }
  // A correction that addresses its own range replaces text elsewhere.
  const target = firstTargetRange(event);
  if (target !== null && !target.collapsed) {
    return null;
  }
  const node = selection.anchorNode;
  const located = node === null ? null : locateRun(node, context);
  if (located === null) {
    return null;
  }
  const offset = selection.anchorOffset;
  const editStart = context.modelOffsetFromDom(located.node, offset);
  if (editStart === null) {
    return null;
  }
  const current = located.node.data;
  return {
    editStart,
    deletedText: '',
    insertedText: data,
    ...located,
    nodeText: current.slice(0, offset) + data + current.slice(offset),
  };
}

// Only with a target range: what one Backspace removes is the platform's
// call (a cluster, or a single code point after some scripts), and taking the
// browser's edit means taking its range too.
function planDelete(
  event: InputEvent,
  context: NativeEditContext
): NativeEdit | null {
  const selection = context.root.ownerDocument.getSelection();
  const target = firstTargetRange(event);
  if (
    selection === null ||
    !selection.isCollapsed ||
    target === null ||
    target.collapsed ||
    target.startContainer !== target.endContainer
  ) {
    return null;
  }
  const located = locateRun(target.startContainer, context);
  if (located === null) {
    return null;
  }
  const { startOffset, endOffset } = target;
  const editStart = context.modelOffsetFromDom(located.node, startOffset);
  if (editStart === null) {
    return null;
  }
  const current = located.node.data;
  return {
    editStart,
    deletedText: current.slice(startOffset, endOffset),
    insertedText: '',
    ...located,
    nodeText: current.slice(0, startOffset) + current.slice(endOffset),
  };
}

// The text node's run span and line, when both are the renderer's own.
function locateRun(
  node: Node,
  context: NativeEditContext
): { line: Element; span: Element; node: Text } | null {
  if (node.nodeType !== Node.TEXT_NODE) {
    return null;
  }
  const span = node.parentNode;
  const line = span?.parentNode;
  if (
    span == null ||
    line == null ||
    !isReusableRun(span) ||
    !context.isLine(line)
  ) {
    return null;
  }
  return { line: line as Element, span: span as Element, node: node as Text };
}

function firstTargetRange(event: InputEvent): StaticRange | null {
  if (typeof event.getTargetRanges !== 'function') {
    return null;
  }
  return event.getTargetRanges()[0] ?? null;
}

// Whether the line's spans, with the planned edit applied to its text node,
// are exactly what the model now projects for the line: the same runs, the
// same styles, the same text. `runs` and `text` are the model after the edit.
//
// This is the whole eligibility rule. A pending style toggle, a link that
// does not extend, a caret on a run boundary where the model and the browser
// pick different spans, a delete that empties a run - each makes the runs
// differ, and the edit is rendered from the model instead.
export function spansMatchRuns(
  edit: NativeEdit,
  runs: readonly StyleRun[],
  text: string
): boolean {
  const spans = edit.line.childNodes;
  if (spans.length !== runs.length) {
    return false;
  }
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i]!;
    const span = spans[i]!;
    if (
      !isReusableRun(span) ||
      (span as Element).className !== classNameFor(run.styles) ||
      (span as HTMLElement).dataset.url !== run.url
    ) {
      return false;
    }
    const shown =
      span === edit.span ? edit.nodeText : (span.firstChild as Text).data;
    if (shown !== text.slice(run.start, run.end)) {
      return false;
    }
  }
  return true;
}

// Whether the browser did what was planned: the same text node, alone in the
// same span, in the same line, holding the predicted text, and no other node
// added to the line.
export function nativeEditLanded(
  edit: NativeEdit,
  isLine: (node: Node) => boolean,
  runCount: number
): boolean {
  return (
    edit.node.parentNode === edit.span &&
    edit.span.childNodes.length === 1 &&
    edit.span.parentNode === edit.line &&
    edit.line.childNodes.length === runCount &&
    isLine(edit.line) &&
    edit.node.data === edit.nodeText
  );
}
