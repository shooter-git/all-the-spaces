/**
 * What the server may build for a body of type `T`: the same shape, except that a `Date` may
 * stand wherever `T` has a plain string. JSON sends a Date as its ISO string, so the web app
 * (which only ever sees the JSON) is typed with strings, and the server's database rows, which
 * hold Dates, still pass. A string-literal union ('ready' | 'failed') takes no Date.
 *
 * Only for the server to check its replies: `return { … } satisfies Sent<Studio>;`.
 */
export type Sent<T> = string extends T
  ? T | Date
  : T extends object
    ? { [K in keyof T]: Sent<T[K]> }
    : T;
