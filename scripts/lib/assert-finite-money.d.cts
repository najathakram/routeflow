/** Returns `value` unchanged; throws NonFiniteMoneyError for NaN, Infinity, undefined, null, '' or non-numeric text. */
export declare function assertFiniteMoney<T>(value: T, label: string): T;
