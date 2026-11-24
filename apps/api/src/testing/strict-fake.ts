/**
 * W-1338: a test fake whose MISSING members are recorded by name instead of reading as a silent `undefined`.
 *
 * Fail-closed production code (open-checkout-session.ts `tenantSessions`) catches every Stripe error and answers
 * one coded 503, so a fake that lacks a method the code now calls does not fail where it is missing: the spec
 * sees a refusal three frames later, or passes on a refusal path. Wrap the fake, then assert `misses` is empty
 * after each test; the failure names the member to add (`stripe.client.checkout`).
 *
 * Nested plain objects are wrapped too (one proxy per object, so identity holds); functions, arrays and values
 * are returned as they are, so `jest.fn()` members keep their `.mock` state.
 */
const IGNORED = new Set([
  // read by jest, pretty-format, Promise resolution and Node's inspector on any object
  "then",
  "toJSON",
  "asymmetricMatch",
  "$$typeof",
  "nodeType",
  "tagName",
  "constructor",
  "inspect",
  "_isMockFunction",
  "@@__IMMUTABLE_ITERABLE__@@",
  "@@__IMMUTABLE_RECORD__@@",
]);

export function strictFake<T extends object>(target: T, name: string, misses: string[]): T {
  const cache = new WeakMap<object, object>();
  const wrap = <O extends object>(obj: O, path: string): O => {
    const hit = cache.get(obj);
    if (hit) return hit as O;
    const proxy = new Proxy(obj, {
      get(o, key, receiver) {
        const value = Reflect.get(o, key, receiver);
        if (typeof key === "symbol") return value;
        if (value === undefined && !(key in o)) {
          if (!IGNORED.has(key)) misses.push(`${path}.${key}`);
          return value;
        }
        return value !== null && typeof value === "object" && !Array.isArray(value)
          ? wrap(value as object, `${path}.${key}`)
          : value;
      },
    });
    cache.set(obj, proxy);
    return proxy;
  };
  return wrap(target, name);
}
