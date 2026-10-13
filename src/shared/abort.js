// Stop one caller's wait without cancelling work owned by other callers.
// Owners of shared work decide when the last caller has left and abort it.
export function waitForPromise(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      cleanup();
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(promise).then(value => {
      cleanup();
      resolve(value);
    }, error => {
      cleanup();
      reject(error);
    });
    if (signal.aborted) onAbort();
  });
}

export function catalogFallback(error) {
  if (error?.name === "AbortError") throw error;
  return undefined;
}
