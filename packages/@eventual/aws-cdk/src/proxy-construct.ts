/**
 * A function which allows a one way interface to be lazily applied.
 *
 * The interface is lazy in that it's methods can be called before the implementation is available.
 *
 * An interface is one way when it consists entirely of methods with no return values (void).
 *
 * ```ts
 * interface OneWay {
 *    setData(data: string): void;
 * }
 *
 * const lazyOneWay = lazyInterface<OneWay>();
 * lazyOneWay.setData("something");
 * lazyOneWay._bind({ setDate: (value) => { console.log(value); } });
 * ```
 */
export function lazyInterface<Iter extends object>(): Iter & {
  _bind: (real: Iter) => void;
} {
  const calls: [keyof Iter, any[]][] = [];
  let real: Iter | undefined = undefined;

  const bind = (obj: Iter) => {
    real = obj;
    calls.forEach(([name, args]) => {
      (obj[name] as Function)?.apply(obj, args);
    });
  };

  return new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (prop === "_bind") {
          return bind;
        } else if (real) {
          return (real[prop as keyof Iter] as Function).bind(real);
        }
        return new Proxy(() => {}, {
          apply: (_target, _this, args) => {
            calls.push([prop as keyof Iter, args]);
          },
        });
      },
    }
  ) as Iter & { _bind: () => {} };
}