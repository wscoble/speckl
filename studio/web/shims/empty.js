// Browser shim for Node built-ins that the SpeckDL parser imports but never
// calls in browser context (fs/path are only used by parseSpeckFile's file I/O).
export default new Proxy(function () {}, {
  get: () => () => {},
  apply: () => ({}),
});