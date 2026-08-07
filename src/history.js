// pushed snapshot is always the pre-action state; undo pops something that predates the action
// getting that backwards is the classic bug in this kind of stack

const CAP = 10;

let past = [];
let future = [];

export function snapshot(elements) {
  return structuredClone(elements);
}

export function pushSnapshot(pre) {
  past.push(pre);
  if (past.length > CAP) past.shift();
  future.length = 0;
}

export function undo(current) {
  if (past.length === 0) return null;
  future.push(snapshot(current));
  if (future.length > CAP) future.shift();
  return past.pop();
}

export function redo(current) {
  if (future.length === 0) return null;
  past.push(snapshot(current));
  if (past.length > CAP) past.shift();
  return future.pop();
}

export function canUndo() {
  return past.length > 0;
}

export function canRedo() {
  return future.length > 0;
}

// canvas switch resets the stack; without it undo on canvas B installs canvas A's elements
export function resetHistory() {
  past = [];
  future = [];
}