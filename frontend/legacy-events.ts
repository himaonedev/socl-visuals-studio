// Global legacy callbacks are active only while the Clipping workspace is shown.
export function installLegacyEventGate() {
  const restore: Array<() => void> = [];
  const targets: EventTarget[] = [window, document, document.body];
  for (const target of targets) {
    const originalAdd = target.addEventListener;
    const originalRemove = target.removeEventListener;
    const callbacks = new WeakMap<object, EventListener>();
    target.addEventListener = (type, callback, options) => {
      if (!callback) return originalAdd.call(target, type, callback, options);
      let wrapped = callbacks.get(callback);
      if (!wrapped) {
        wrapped = event => {
          if (window.__soclEditorActive) return;
          if (typeof callback === 'function') callback.call(target, event);
          else callback.handleEvent(event);
        };
        callbacks.set(callback, wrapped);
      }
      originalAdd.call(target, type, wrapped, options);
    };
    target.removeEventListener = (type, callback, options) => {
      originalRemove.call(target, type, (callback && callbacks.get(callback)) || callback, options);
    };
    restore.push(() => { target.addEventListener = originalAdd; });
  }
  return () => restore.forEach(restoreTarget => restoreTarget());
}
